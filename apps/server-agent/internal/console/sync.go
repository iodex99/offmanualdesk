package console

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"offmanual/desk/server-agent/internal/store"
)

// Meta keys in agent.db.
const (
	MetaServerID   = "server_id"
	MetaServerKey  = "server_key_dpapi" // base64 of the DPAPI-protected ed25519 seed
	MetaConsoleURL = "console_url"
	MetaPolicyETag = "policy_etag"
	MetaPolicyJSON = "policy_json"
	MetaFirmStatus = "firm_status"
	MetaLastAck    = "last_console_contact_at"
	MetaAuditSent  = "audit_summary_sent_through" // last date (YYYY-MM-DD IST) uploaded
)

// Syncer runs the heartbeat/policy/audit loop (ARCHITECTURE §3.3).
type Syncer struct {
	Client       *Client
	Store        *store.Store
	Log          *slog.Logger
	Interval     time.Duration
	AgentVersion string
	Seats        func(context.Context) int
}

var ist = time.FixedZone("IST", 5*3600+1800)

// Run loops until ctx ends. Failures are logged and retried next tick; the
// licence keeps working offline for the grace period (BILLING §6).
func (s *Syncer) Run(ctx context.Context) {
	if s.Interval == 0 {
		s.Interval = 15 * time.Minute
	}
	t := time.NewTicker(s.Interval)
	defer t.Stop()
	for {
		s.Once(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Once performs one heartbeat + policy sync + pending audit upload.
func (s *Syncer) Once(ctx context.Context) {
	seats := 0
	if s.Seats != nil {
		seats = s.Seats(ctx)
	}
	reply, err := s.Client.SendHeartbeat(ctx, Heartbeat{AgentVersion: s.AgentVersion, Health: "green", ActiveSeats: seats})
	if err != nil {
		s.Log.Warn("heartbeat failed", "error", err.Error())
		return
	}
	_ = s.Store.SetMeta(ctx, MetaFirmStatus, reply.FirmStatus)
	_ = s.Store.SetMeta(ctx, MetaLastAck, time.Now().UTC().Format(time.RFC3339))
	if err := s.syncPolicy(ctx); err != nil {
		s.Log.Warn("policy sync failed", "error", err.Error())
	}
	if err := s.uploadAudit(ctx); err != nil {
		s.Log.Warn("audit summary upload failed", "error", err.Error())
	}
}

func (s *Syncer) syncPolicy(ctx context.Context) error {
	etag, _ := s.Store.Meta(ctx, MetaPolicyETag)
	p, newTag, notModified, err := s.Client.FetchPolicy(ctx, etag)
	if err != nil || notModified {
		return err
	}
	return ApplyPolicy(ctx, s.Store, p, newTag)
}

// ApplyPolicy writes the console's employee list into the local store. Employees the
// console no longer lists (deleted) are disabled locally (offboarding, F10).
func ApplyPolicy(ctx context.Context, st *store.Store, p Policy, etag string) error {
	listed := map[string]bool{}
	for _, e := range p.Employees {
		if e.SID == "" {
			continue
		}
		listed[e.SID] = true
		if err := st.UpsertEmployee(ctx, store.Employee{SID: e.SID, EmployeeID: e.EmployeeID, Name: e.Name, Status: e.Status, Packs: e.Packs}); err != nil {
			return err
		}
	}
	sids, err := st.EmployeeSIDs(ctx)
	if err != nil {
		return err
	}
	for _, sid := range sids {
		if !listed[sid] {
			if err := st.DisableEmployee(ctx, sid); err != nil {
				return err
			}
		}
	}
	if raw, err := jsonCompact(p); err == nil {
		_ = st.SetMeta(ctx, MetaPolicyJSON, raw)
	}
	return st.SetMeta(ctx, MetaPolicyETag, etag)
}

// uploadAudit sends complete days (yesterday and earlier, IST) not yet sent.
func (s *Syncer) uploadAudit(ctx context.Context) error {
	today := time.Now().In(ist)
	yesterday := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, ist).AddDate(0, 0, -1)
	sent, _ := s.Store.Meta(ctx, MetaAuditSent)
	day := yesterday.AddDate(0, 0, -6) // at most a week of backlog
	if t, err := time.ParseInLocation("2006-01-02", sent, ist); err == nil && t.After(day) {
		day = t.AddDate(0, 0, 1)
	}
	for ; !day.After(yesterday); day = day.AddDate(0, 0, 1) {
		counts, err := s.Store.AuditSummary(ctx, day, day.AddDate(0, 0, 1))
		if err != nil {
			return err
		}
		out := make([]AuditCount, 0, len(counts))
		for _, c := range counts {
			out = append(out, AuditCount{Category: c.Category, Count: c.Count})
		}
		if err := s.Client.SendAuditSummary(ctx, day.Format("2006-01-02"), out); err != nil {
			return err
		}
		if err := s.Store.SetMeta(ctx, MetaAuditSent, day.Format("2006-01-02")); err != nil {
			return err
		}
	}
	return nil
}

func jsonCompact(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}
