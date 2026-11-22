//! Chat panel and Review tab plumbing (ADR-021, ADR-041): one gateway client per Desk,
//! connected on first use to the gateway Desk started. The token never reaches the UI;
//! the UI gets only trimmed `chat` events (`om-chat`) and plain errors.

use crate::gateway_client::{self, Client, ClientError, ConnectOptions, EventSink};
use crate::gateway_manager::{GatewayError, GatewayState};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CHAT_EVENT: &str = "om-chat";
pub const MAX_MESSAGE_CHARS: usize = 20_000;

#[derive(Default)]
pub struct ChatState(Mutex<Option<Client>>);

fn err(message: &str) -> GatewayError {
    GatewayError {
        message: message.to_string(),
    }
}

fn plain(e: ClientError) -> GatewayError {
    match e {
        ClientError::Unavailable => err("Your assistant isn't running. Start it and try again."),
        ClientError::Auth => {
            err("Desk couldn't connect to your assistant. Restart Off Manual Desk; if it keeps happening, use Report a problem.")
        }
        ClientError::Timeout => err("Your assistant didn't answer in time. Try again."),
        // Gateway error text is technical; keep it out of the UI (plain-language rule).
        ClientError::Failed(_) => err("Your assistant couldn't do that. Try again."),
    }
}

fn device_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| {
        PathBuf::from(d)
            .join("OffManual")
            .join("desk")
            .join("device.key")
    })
}

/// Runs `f` with a live client, connecting (or reconnecting) when needed.
pub fn with_client<T>(
    gateway: &GatewayState,
    chat: &ChatState,
    sink: EventSink,
    f: impl FnOnce(&Client) -> Result<T, ClientError>,
) -> Result<T, GatewayError> {
    let (port, token) = gateway
        .endpoint()
        .ok_or_else(|| plain(ClientError::Unavailable))?;
    let mut guard = chat
        .0
        .lock()
        .map_err(|_| err("Off Manual hit a problem. Restart it."))?;
    if !guard.as_ref().is_some_and(Client::is_alive) {
        let path =
            device_path().ok_or_else(|| err("Your Windows profile folder couldn't be found."))?;
        let device = gateway_client::load_or_create_device(&path)
            .ok_or_else(|| err("Desk couldn't create its sign-in key. Use Report a problem."))?;
        let opts = ConnectOptions {
            port,
            token: &token,
            device: &device,
            version: env!("CARGO_PKG_VERSION"),
        };
        *guard = Some(Client::connect(&opts, sink).map_err(plain)?);
    }
    match guard.as_ref() {
        Some(c) => f(c).map_err(plain),
        None => Err(plain(ClientError::Unavailable)),
    }
}

fn idempotency_key() -> String {
    let mut b = [0u8; 12];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Validates and sends a chat message; returns the run id. Replies stream as `om-chat` events.
pub fn send(
    gateway: &GatewayState,
    chat: &ChatState,
    sink: EventSink,
    message: &str,
) -> Result<String, GatewayError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(err("Type a message first."));
    }
    if message.chars().count() > MAX_MESSAGE_CHARS {
        return Err(err(
            "That message is too long. Shorten it or attach the file instead.",
        ));
    }
    let ack = with_client(gateway, chat, sink, |c| {
        c.request(
            "chat.send",
            json!({
                "sessionKey": gateway_client::DESK_SESSION_KEY,
                "message": message,
                "idempotencyKey": idempotency_key(),
            }),
            Duration::from_secs(30),
        )
    })?;
    ack["runId"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| err("Unexpected reply from your assistant."))
}

pub fn abort(
    gateway: &GatewayState,
    chat: &ChatState,
    sink: EventSink,
    run_id: Option<&str>,
) -> Result<(), GatewayError> {
    let mut p = json!({ "sessionKey": gateway_client::DESK_SESSION_KEY });
    if let Some(id) = run_id.filter(|s| !s.is_empty() && s.len() <= 128) {
        p["runId"] = json!(id);
    }
    with_client(gateway, chat, sink, |c| {
        c.request("chat.abort", p, Duration::from_secs(10))
    })
    .map(|_| ())
}

/// Builds `offmanual.review.decide` params after checking shapes (the guard checks again).
pub fn decide_params(
    ids: &[String],
    decision: &str,
    edited: Option<Value>,
    step_up_grant: Option<String>,
) -> Result<Value, GatewayError> {
    if ids.is_empty()
        || ids.len() > 100
        || !ids
            .iter()
            .all(|i| !i.is_empty() && i.len() <= 9 && i.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(err("Pick at least one item."));
    }
    if decision != "approve" && decision != "reject" {
        return Err(err("Unknown choice."));
    }
    let mut p = json!({ "ids": ids, "decision": decision });
    if let Some(e) = edited {
        if ids.len() != 1 {
            return Err(err("Edit one item at a time."));
        }
        p["params"] = e;
    }
    if let Some(g) = step_up_grant {
        if g.len() != 32 || !g.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(err("Enter today's code again."));
        }
        p["stepUpGrant"] = json!(g);
    }
    Ok(p)
}

/// The sink Desk uses: forwards trimmed chat events to the UI.
pub fn ui_sink(emit: impl Fn(Value) + Send + Sync + 'static) -> EventSink {
    Arc::new(move |name, payload| {
        if name == "chat" {
            if let Some(v) = gateway_client::chat_event_for_ui(payload) {
                emit(v);
            }
        }
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn decide_params_checks_shapes() {
        let ids = vec!["1".to_string(), "2".to_string()];
        assert_eq!(
            decide_params(&ids, "approve", None, None).unwrap(),
            json!({"ids":["1","2"],"decision":"approve"})
        );
        assert!(decide_params(&[], "approve", None, None).is_err());
        assert!(decide_params(&["x1".into()], "approve", None, None).is_err());
        assert!(decide_params(&ids, "maybe", None, None).is_err());
        assert!(decide_params(&ids, "approve", Some(json!({})), None).is_err());
        assert_eq!(
            decide_params(
                &["3".into()],
                "approve",
                Some(json!({"paths":["C:\\a.pdf"]})),
                None
            )
            .unwrap()["params"]["paths"][0],
            "C:\\a.pdf"
        );
    }

    #[test]
    fn decide_params_carries_a_well_formed_step_up_grant() {
        let ids = vec!["1".to_string()];
        let g = "0123456789abcdef0123456789abcdef".to_string();
        assert_eq!(
            decide_params(&ids, "approve", None, Some(g.clone())).unwrap()["stepUpGrant"],
            g.as_str()
        );
        assert!(decide_params(&ids, "approve", None, Some("xyz".into())).is_err());
    }

    #[test]
    fn send_refuses_empty_and_long_messages_and_a_stopped_gateway() {
        let g = GatewayState::default();
        let c = ChatState::default();
        let sink = ui_sink(|_| {});
        assert_eq!(
            send(&g, &c, Arc::clone(&sink), "  ").unwrap_err().message,
            "Type a message first."
        );
        let long = "a".repeat(MAX_MESSAGE_CHARS + 1);
        assert!(send(&g, &c, Arc::clone(&sink), &long)
            .unwrap_err()
            .message
            .contains("too long"));
        assert!(send(&g, &c, sink, "hi")
            .unwrap_err()
            .message
            .contains("isn't running"));
    }

    #[test]
    fn errors_are_plain() {
        for e in [
            ClientError::Unavailable,
            ClientError::Auth,
            ClientError::Timeout,
            ClientError::Failed("INVALID_REQUEST: stack trace".into()),
        ] {
            let m = plain(e).message;
            assert!(!m.contains("INVALID") && !m.contains("stack"));
        }
    }
}
