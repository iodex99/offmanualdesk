package console

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"

	"offmanual/desk/server-agent/internal/store"
	"offmanual/desk/server-agent/internal/update"
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
	MetaUsageSent  = "usage_sent_through"         // last complete usage day uploaded (ADR-051)
)

// Syncer runs the heartbeat/policy/audit loop (ARCHITECTURE §3.3).
type Syncer struct {
	Client       *Client
	Store        *store.Store
	Log          *slog.Logger
	Interval     time.Duration
	AgentVersion string
	Seats        func(context.Context) int
	// Stager stages the assigned release in the background (nil disables updates).
	Stager  *update.Stager
	staging atomic.Bool
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
	staged, _ := s.Store.StagedVersion(ctx)
	reply, err := s.Client.SendHeartbeat(ctx, Heartbeat{AgentVersion: s.AgentVersion, Health: "green", ActiveSeats: seats, StagedVersion: staged})
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
	if err := s.uploadUsage(ctx); err != nil {
		s.Log.Warn("usage upload failed", "error", err.Error())
	}
	if err := s.syncNotices(ctx); err != nil {
		s.Log.Warn("notices sync failed", "error", err.Error())
	}
	s.maybeStage(ctx)
}

// maybeStage fetches the assigned release and stages it once, in the background.
func (s *Syncer) maybeStage(ctx context.Context) {
	if s.Stager == nil || !s.staging.CompareAndSwap(false, true) {
		return
	}
	rel, err := s.Client.FetchRelease(ctx)
	if err != nil || rel == nil || rel.Version == s.AgentVersion {
		s.staging.Store(false)
		if err != nil {
			s.Log.Warn("release check failed", "error", err.Error())
		}
		return
	}
	deadline, _ := time.Parse(time.RFC3339, rel.DeadlineAt) // zero when absent
	if st, _ := s.Store.UpdateState(ctx, rel.Version); st == "staged" || st == "active" {
		// Severity and deadline can change after staging (e.g. a release marked security later).
		_ = s.Store.SetUpdateMeta(ctx, rel.Version, rel.Severity, deadline)
		s.staging.Store(false)
		return
	}
	go func() {
		defer s.staging.Store(false)
		err := s.Stager.Stage(ctx, update.Release{Version: rel.Version, ManifestURL: rel.ManifestURL, PayloadSHA256: rel.PayloadSHA256, KeyID: rel.KeyID})
		if err != nil {
			s.Log.Error("staging failed", "version", rel.Version, "error", err.Error())
			return
		}
		_ = s.Store.SetUpdateMeta(ctx, rel.Version, rel.Severity, deadline)
		s.Log.Info("release staged", "version", rel.Version, "severity", rel.Severity)
	}()
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
		if err := st.SetEmployeeAdmin(ctx, e.SID, e.Admin); err != nil {
			return err
		}
		if err := st.SetEmployeeTaskRole(ctx, e.SID, e.TaskRole); err != nil {
			return err
		}
		// Switched off in the console: same clean-up as removal (day grant, lease and
		// its tokens, Telegram link), not only the status (F10).
		if e.Status == "disabled" {
			if err := st.DisableEmployee(ctx, e.SID); err != nil {
				return err
			}
		} else if err := st.CancelOffboarding(ctx, e.SID); err != nil {
			// Switched on again: an archive not made yet is not made (ADR-056).
			return err
		}
		if t, err := time.Parse(time.RFC3339, e.TOTPResetAt); err == nil {
			if _, err := st.ApplyTOTPReset(ctx, e.SID, t); err != nil {
				return err
			}
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

// uploadUsage sends complete days (yesterday and earlier, IST) of per-employee usage
// counts not yet sent, at most a week of backlog (ADR-051).
func (s *Syncer) uploadUsage(ctx context.Context) error {
	today := time.Now().In(ist)
	yesterday := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, ist).AddDate(0, 0, -1)
	sent, _ := s.Store.Meta(ctx, MetaUsageSent)
	day := yesterday.AddDate(0, 0, -6)
	if t, err := time.ParseInLocation("2006-01-02", sent, ist); err == nil && t.After(day) {
		day = t.AddDate(0, 0, 1)
	}
	for ; !day.After(yesterday); day = day.AddDate(0, 0, 1) {
		date := day.Format("2006-01-02")
		rows, err := s.Store.UsageForDate(ctx, date)
		if err != nil {
			return err
		}
		out := make([]UsageCount, 0, len(rows))
		for _, r := range rows {
			if r.EmployeeID == "" {
				continue
			}
			out = append(out, UsageCount{EmployeeID: r.EmployeeID, Turns: r.Turns, InputTokens: r.InputTokens, OutputTokens: r.OutputTokens})
		}
		if err := s.Client.SendUsage(ctx, date, out); err != nil {
			return err
		}
		if err := s.Store.SetMeta(ctx, MetaUsageSent, date); err != nil {
			return err
		}
	}
	return nil
}

// syncNotices mirrors the console's active notices for this firm (ADR-052).
func (s *Syncer) syncNotices(ctx context.Context) error {
	list, err := s.Client.FetchNotices(ctx)
	if err != nil {
		return err
	}
	out := make([]store.Notice, 0, len(list))
	for _, n := range list {
		created, _ := time.Parse(time.RFC3339, n.StartsAt)
		out = append(out, store.Notice{ID: n.ID, Kind: n.Kind, Audience: n.Audience, Title: n.Title, Body: n.Body, Created: created})
	}
	return s.Store.ReplaceNotices(ctx, out)
}

func jsonCompact(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}

// RetentionDays is the firm's retention for offboarding archives (policy
// retentionDays, 30..3650), or 0 when no policy has been synced yet.
func RetentionDays(ctx context.Context, st *store.Store) int {
	raw, err := st.Meta(ctx, MetaPolicyJSON)
	if err != nil || raw == "" {
		return 0
	}
	var p struct {
		Policy struct {
			RetentionDays int `json:"retentionDays"`
		} `json:"policy"`
	}
	if json.Unmarshal([]byte(raw), &p) != nil || p.Policy.RetentionDays < 30 || p.Policy.RetentionDays > 3650 {
		return 0
	}
	return p.Policy.RetentionDays
}
