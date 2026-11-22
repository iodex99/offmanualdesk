//! Desk's client for its own gateway (ADR-021): protocol v4 with Ed25519 device auth,
//! from the Rust side (no browser Origin). A port of the Server Agent's Go client
//! (`apps/server-agent/internal/gateway`), whose wire details are verified in the
//! OpenClaw 2026.11.6 source (docs/OPENCLAW_NOTES.md §3):
//!
//! - frames: req {type,id,method,params} / res {type,id,ok,payload,error} / event {type,event,payload}
//! - handshake: event `connect.challenge` {nonce, ts} → req `connect` → res payload {type:"hello-ok"}
//! - device id = hex(sha256(raw public key)); key and signature base64url without padding;
//!   signature over the "v3" payload (`payload_v3`)
//!
//! One background thread owns the socket: it sends queued requests, matches responses
//! by id, and hands events to a sink (Desk forwards `chat` events to the UI).
//! client.id/mode for Desk: [A L2] (same values as the relay until the lab says otherwise).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use tungstenite::{Message, WebSocket};

pub const PROTOCOL: u64 = 4;
pub const CLIENT_ID: &str = "gateway-client";
pub const CLIENT_MODE: &str = "backend";
pub const ROLE: &str = "operator";
/// Chat (read/write) and the Review tab (approvals: `offmanual.review.*`, ADR-041).
pub const SCOPES: [&str; 3] = ["operator.read", "operator.write", "operator.approvals"];
/// Desk's own chat session. [A L2: key format]
pub const DESK_SESSION_KEY: &str = "agent:main:main";

const MAX_MESSAGE: usize = 8 << 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// The gateway isn't reachable (not started, stopped, or the connection dropped).
    Unavailable,
    /// The gateway refused our token or device signature.
    Auth,
    /// The gateway answered the request with an error.
    Failed(String),
    /// No answer in time.
    Timeout,
}

// ---- device identity ----

pub struct Device {
    key: SigningKey,
}

impl Device {
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Device {
            key: SigningKey::from_bytes(seed),
        }
    }

    pub fn generate() -> Option<(Self, [u8; 32])> {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).ok()?;
        Some((Self::from_seed(&seed), seed))
    }

    fn public_raw(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    /// hex(sha256(raw public key)).
    pub fn id(&self) -> String {
        hex(&Sha256::digest(self.public_raw()))
    }

    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public_raw())
    }

    pub fn sign(&self, payload: &str) -> String {
        URL_SAFE_NO_PAD.encode(self.key.sign(payload.as_bytes()).to_bytes())
    }
}

fn hex(b: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(DIGITS[usize::from(x >> 4)] as char);
        s.push(DIGITS[usize::from(x & 0x0f)] as char);
    }
    s
}

/// Trims and lower-cases ASCII A–Z (device-auth.ts normalizeDeviceMetadataForAuth).
fn normalize_meta(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

/// The exact string the gateway verifies (buildDeviceAuthPayloadV3).
#[allow(clippy::too_many_arguments)]
pub fn payload_v3(
    device_id: &str,
    client_id: &str,
    client_mode: &str,
    role: &str,
    scopes: &[&str],
    signed_at_ms: i64,
    token: &str,
    nonce: &str,
    platform: &str,
    device_family: &str,
) -> String {
    [
        "v3".to_string(),
        device_id.to_string(),
        client_id.to_string(),
        client_mode.to_string(),
        role.to_string(),
        scopes.join(","),
        signed_at_ms.to_string(),
        token.to_string(),
        nonce.to_string(),
        normalize_meta(platform),
        normalize_meta(device_family),
    ]
    .join("|")
}

/// Loads the per-user device key (DPAPI CurrentUser) or creates and stores a new one.
pub fn load_or_create_device(path: &Path) -> Option<Device> {
    if let Ok(blob) = std::fs::read(path) {
        if let Some(seed) = crate::dpapi::unprotect(&blob) {
            if let Ok(seed) = <[u8; 32]>::try_from(seed.as_slice()) {
                return Some(Device::from_seed(&seed));
            }
        }
    }
    let (device, seed) = Device::generate()?;
    let blob = crate::dpapi::protect(&seed)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok()?;
    }
    std::fs::write(path, blob).ok()?;
    Some(device)
}

// ---- connection ----

pub type EventSink = Arc<dyn Fn(&str, &Value) + Send + Sync>;

type Reply = mpsc::Sender<Result<Value, ClientError>>;

enum Cmd {
    Request {
        method: String,
        params: Value,
        reply: Reply,
    },
}

pub struct Client {
    tx: mpsc::Sender<Cmd>,
    alive: Arc<AtomicBool>,
}

static SEQ: AtomicU64 = AtomicU64::new(1);

fn next_id() -> String {
    format!("desk-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if io.kind() == io::ErrorKind::WouldBlock || io.kind() == io::ErrorKind::TimedOut)
}

fn send_json(ws: &mut WebSocket<TcpStream>, v: &Value) -> Result<(), ClientError> {
    ws.send(Message::text(v.to_string()))
        .map_err(|_| ClientError::Unavailable)
}

fn read_json(ws: &mut WebSocket<TcpStream>) -> Result<Option<Value>, tungstenite::Error> {
    match ws.read()? {
        Message::Text(t) => Ok(serde_json::from_str(t.as_str()).ok()),
        Message::Close(_) => Err(tungstenite::Error::ConnectionClosed),
        _ => Ok(None),
    }
}

pub struct ConnectOptions<'a> {
    pub port: u16,
    pub token: &'a str,
    pub device: &'a Device,
    pub version: &'a str,
}

impl Client {
    /// Connects to ws://127.0.0.1:<port> and completes the v4 handshake.
    pub fn connect(o: &ConnectOptions<'_>, sink: EventSink) -> Result<Client, ClientError> {
        if o.port == 0 || o.token.is_empty() {
            return Err(ClientError::Unavailable);
        }
        let addr = SocketAddr::from(([127, 0, 0, 1], o.port));
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
            .map_err(|_| ClientError::Unavailable)?;
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .map_err(|_| ClientError::Unavailable)?;
        let config = tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let (mut ws, _resp) = tungstenite::client::client_with_config(
            format!("ws://127.0.0.1:{}", o.port),
            stream,
            Some(config),
        )
        .map_err(|_| ClientError::Unavailable)?;

        // 1. challenge
        let (nonce, ts) = loop {
            let f = read_json(&mut ws).map_err(|_| ClientError::Unavailable)?;
            let Some(f) = f else { continue };
            if f["type"] == "event" && f["event"] == "connect.challenge" {
                let nonce = f["payload"]["nonce"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                let ts = f["payload"]["ts"].as_i64().unwrap_or_default();
                if nonce.is_empty() {
                    return Err(ClientError::Unavailable);
                }
                break (nonce, ts);
            }
        };
        // 2. connect
        let platform = "windows";
        let payload = payload_v3(
            &o.device.id(),
            CLIENT_ID,
            CLIENT_MODE,
            ROLE,
            &SCOPES,
            ts,
            o.token,
            &nonce,
            platform,
            "",
        );
        let id = next_id();
        send_json(
            &mut ws,
            &json!({
                "type": "req", "id": id, "method": "connect",
                "params": {
                    "minProtocol": PROTOCOL, "maxProtocol": PROTOCOL,
                    "client": { "id": CLIENT_ID, "version": o.version, "platform": platform, "mode": CLIENT_MODE },
                    "role": ROLE, "scopes": SCOPES, "caps": [],
                    "auth": { "token": o.token },
                    "device": {
                        "id": o.device.id(), "publicKey": o.device.public_key(),
                        "signature": o.device.sign(&payload), "signedAt": ts, "nonce": nonce,
                    },
                },
            }),
        )?;
        loop {
            let f = read_json(&mut ws).map_err(|_| ClientError::Unavailable)?;
            let Some(f) = f else { continue };
            if f["type"] == "res" && f["id"] == id.as_str() {
                if f["ok"] != true || f["payload"]["type"] != "hello-ok" {
                    return Err(ClientError::Auth);
                }
                break;
            }
        }
        // 3. steady state: short read timeout so queued requests go out promptly.
        ws.get_mut()
            .set_read_timeout(Some(Duration::from_millis(50)))
            .map_err(|_| ClientError::Unavailable)?;
        let (tx, rx) = mpsc::channel::<Cmd>();
        let alive = Arc::new(AtomicBool::new(true));
        let alive2 = Arc::clone(&alive);
        std::thread::Builder::new()
            .name("om-gateway-client".into())
            .spawn(move || run(ws, rx, sink, alive2))
            .map_err(|_| ClientError::Unavailable)?;
        Ok(Client { tx, alive })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Sends a request and waits for its response.
    pub fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ClientError> {
        if !self.is_alive() {
            return Err(ClientError::Unavailable);
        }
        let (reply, wait) = mpsc::channel();
        self.tx
            .send(Cmd::Request {
                method: method.to_string(),
                params,
                reply,
            })
            .map_err(|_| ClientError::Unavailable)?;
        match wait.recv_timeout(timeout) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ClientError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ClientError::Unavailable),
        }
    }
}

fn run(
    mut ws: WebSocket<TcpStream>,
    rx: mpsc::Receiver<Cmd>,
    sink: EventSink,
    alive: Arc<AtomicBool>,
) {
    let mut pending: HashMap<String, Reply> = HashMap::new();
    'outer: loop {
        loop {
            match rx.try_recv() {
                Ok(Cmd::Request {
                    method,
                    params,
                    reply,
                }) => {
                    let id = next_id();
                    let frame =
                        json!({ "type": "req", "id": id, "method": method, "params": params });
                    if send_json(&mut ws, &frame).is_err() {
                        let _ = reply.send(Err(ClientError::Unavailable));
                        break 'outer;
                    }
                    pending.insert(id, reply);
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    break 'outer;
                }
            }
        }
        match read_json(&mut ws) {
            Ok(Some(f)) => dispatch(&f, &mut pending, &sink),
            Ok(None) => {}
            Err(e) if is_timeout(&e) => {}
            Err(_) => break,
        }
    }
    alive.store(false, Ordering::SeqCst);
    for (_, reply) in pending.drain() {
        let _ = reply.send(Err(ClientError::Unavailable));
    }
}

fn dispatch(f: &Value, pending: &mut HashMap<String, Reply>, sink: &EventSink) {
    match f["type"].as_str() {
        Some("res") => {
            let Some(reply) = f["id"].as_str().and_then(|id| pending.remove(id)) else {
                return;
            };
            let r = if f["ok"] == true {
                Ok(f["payload"].clone())
            } else {
                Err(ClientError::Failed(
                    f["error"]["message"]
                        .as_str()
                        .unwrap_or("request failed")
                        .to_string(),
                ))
            };
            let _ = reply.send(r);
        }
        Some("event") => {
            if let Some(name) = f["event"].as_str() {
                sink(name, &f["payload"]);
            }
        }
        _ => {}
    }
}

/// The fields of a `chat` event Desk's UI needs (no other session data is forwarded).
pub fn chat_event_for_ui(payload: &Value) -> Option<Value> {
    let run_id = payload["runId"].as_str()?;
    let state = payload["state"].as_str()?;
    if !matches!(state, "status" | "delta" | "final" | "aborted" | "error") {
        return None;
    }
    if let Some(key) = payload["sessionKey"].as_str() {
        if key != DESK_SESSION_KEY {
            return None; // Telegram turns stay out of the Desk chat panel
        }
    }
    Some(json!({
        "runId": run_id,
        "state": state,
        "deltaText": payload["deltaText"].as_str().unwrap_or_default(),
        "replace": payload["replace"] == true,
        "errorMessage": payload["errorMessage"].as_str().unwrap_or_default(),
    }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use std::net::TcpListener;
    use std::sync::Mutex;

    #[test]
    fn payload_matches_the_go_client() {
        // Same inputs and expected string as server-agent/internal/gateway TestPayloadV3AndDeviceID.
        let p = payload_v3(
            "dev",
            "gateway-client",
            "backend",
            "operator",
            &["operator.read", "operator.write"],
            123,
            "tok",
            "non",
            " Windows ",
            "",
        );
        assert_eq!(
            p,
            "v3|dev|gateway-client|backend|operator|operator.read,operator.write|123|tok|non|windows|"
        );
    }

    #[test]
    fn device_id_and_key_encoding() {
        let d = Device::from_seed(&[7u8; 32]);
        assert_eq!(d.id().len(), 64);
        assert_eq!(d.id(), hex(&Sha256::digest(d.public_raw())));
        assert!(!d.public_key().contains('=') && !d.public_key().contains('+'));
        let sig = URL_SAFE_NO_PAD.decode(d.sign("hello")).unwrap();
        let vk = VerifyingKey::from_bytes(&d.public_raw()).unwrap();
        let sig = Signature::from_slice(&sig).unwrap();
        assert!(vk.verify(b"hello", &sig).is_ok());
    }

    #[test]
    fn chat_events_are_filtered_and_trimmed() {
        let ok = chat_event_for_ui(&json!({"runId":"r1","state":"delta","deltaText":"hi","sessionKey":DESK_SESSION_KEY,"message":{"secret":1}})).unwrap();
        assert_eq!(
            ok,
            json!({"runId":"r1","state":"delta","deltaText":"hi","replace":false,"errorMessage":""})
        );
        assert!(chat_event_for_ui(
            &json!({"runId":"r1","state":"delta","sessionKey":"agent:main:telegram"})
        )
        .is_none());
        assert!(chat_event_for_ui(&json!({"runId":"r1","state":"weird"})).is_none());
        assert!(chat_event_for_ui(&json!({"state":"final"})).is_none());
    }

    /// A fake gateway that re-implements the server's v3 signature check.
    fn fake_gateway(token: &'static str) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in l.incoming() {
                let Ok(stream) = stream else { return };
                std::thread::spawn(move || {
                    let mut ws = tungstenite::accept(stream).unwrap();
                    let challenge = json!({"type":"event","event":"connect.challenge","payload":{"nonce":"n-1","ts":1700000000000_i64}});
                    ws.send(Message::text(challenge.to_string())).unwrap();
                    let connect: Value = loop {
                        if let Message::Text(t) = ws.read().unwrap() {
                            break serde_json::from_str(t.as_str()).unwrap();
                        }
                    };
                    let p = &connect["params"];
                    let pk = URL_SAFE_NO_PAD
                        .decode(p["device"]["publicKey"].as_str().unwrap())
                        .unwrap();
                    let vk = VerifyingKey::from_bytes(&pk.clone().try_into().unwrap()).unwrap();
                    let scopes: Vec<&str> = p["scopes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|s| s.as_str().unwrap())
                        .collect();
                    let payload = payload_v3(
                        &hex(&Sha256::digest(&pk)),
                        p["client"]["id"].as_str().unwrap(),
                        p["client"]["mode"].as_str().unwrap(),
                        p["role"].as_str().unwrap(),
                        &scopes,
                        p["device"]["signedAt"].as_i64().unwrap(),
                        p["auth"]["token"].as_str().unwrap(),
                        p["device"]["nonce"].as_str().unwrap(),
                        p["client"]["platform"].as_str().unwrap(),
                        "",
                    );
                    let sig = URL_SAFE_NO_PAD
                        .decode(p["device"]["signature"].as_str().unwrap())
                        .unwrap();
                    let sig_ok = vk
                        .verify(payload.as_bytes(), &Signature::from_slice(&sig).unwrap())
                        .is_ok();
                    let id_ok = p["device"]["id"] == hex(&Sha256::digest(&pk)).as_str();
                    let ok =
                        sig_ok && id_ok && p["auth"]["token"] == token && p["minProtocol"] == 4;
                    let res = if ok {
                        json!({"type":"res","id":connect["id"],"ok":true,"payload":{"type":"hello-ok","protocol":4}})
                    } else {
                        json!({"type":"res","id":connect["id"],"ok":false,"error":{"code":"AUTH","message":"unauthorized"}})
                    };
                    ws.send(Message::text(res.to_string())).unwrap();
                    if !ok {
                        return;
                    }
                    loop {
                        let msg = match ws.read() {
                            Ok(Message::Text(t)) => t,
                            Ok(_) => continue,
                            Err(_) => return,
                        };
                        let req: Value = serde_json::from_str(msg.as_str()).unwrap();
                        match req["method"].as_str().unwrap() {
                            "chat.send" => {
                                let ack = json!({"type":"res","id":req["id"],"ok":true,"payload":{"runId":"run-1"}});
                                ws.send(Message::text(ack.to_string())).unwrap();
                                for (state, text) in
                                    [("delta", "Hel"), ("delta", "lo"), ("final", "")]
                                {
                                    let ev = json!({"type":"event","event":"chat","payload":{"runId":"run-1","sessionKey":DESK_SESSION_KEY,"state":state,"deltaText":text}});
                                    ws.send(Message::text(ev.to_string())).unwrap();
                                }
                            }
                            "boom" => {
                                let r = json!({"type":"res","id":req["id"],"ok":false,"error":{"code":"X","message":"nope"}});
                                ws.send(Message::text(r.to_string())).unwrap();
                            }
                            "hangup" => return,
                            _ => {}
                        }
                    }
                });
            }
        });
        port
    }

    #[test]
    fn handshake_request_events_and_errors() {
        let port = fake_gateway("good-token");
        let device = Device::from_seed(&[9u8; 32]);
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let ev2 = Arc::clone(&events);
        let sink: EventSink = Arc::new(move |name, payload| {
            if name == "chat" {
                if let Some(v) = chat_event_for_ui(payload) {
                    ev2.lock().unwrap().push(v);
                }
            }
        });
        let opts = ConnectOptions {
            port,
            token: "good-token",
            device: &device,
            version: "test",
        };
        let c = Client::connect(&opts, Arc::clone(&sink)).unwrap();
        let ack = c
            .request(
                "chat.send",
                json!({"sessionKey": DESK_SESSION_KEY, "message": "hi"}),
                Duration::from_secs(5),
            )
            .unwrap();
        assert_eq!(ack["runId"], "run-1");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while events.lock().unwrap().len() < 3 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let states: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e["state"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(states, ["delta", "delta", "final"]);
        assert_eq!(
            c.request("boom", json!({}), Duration::from_secs(5)),
            Err(ClientError::Failed("nope".into()))
        );
        assert_eq!(
            c.request("hangup", json!({}), Duration::from_secs(5)),
            Err(ClientError::Unavailable)
        );
        assert!(!c.is_alive());

        let bad = ConnectOptions {
            port,
            token: "wrong",
            device: &device,
            version: "test",
        };
        assert_eq!(Client::connect(&bad, sink).err(), Some(ClientError::Auth));
    }

    #[test]
    fn nothing_listening_is_unavailable() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let device = Device::from_seed(&[1u8; 32]);
        let sink: EventSink = Arc::new(|_, _| {});
        let o = ConnectOptions {
            port,
            token: "t",
            device: &device,
            version: "test",
        };
        assert_eq!(
            Client::connect(&o, sink).err(),
            Some(ClientError::Unavailable)
        );
    }
}
