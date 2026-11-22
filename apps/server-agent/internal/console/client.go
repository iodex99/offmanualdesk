package console

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// EnrolmentServerID is the X-OM-Server value for enrolment (proof of possession).
const EnrolmentServerID = "srv_enrollment"

// Client talks to the console agent API. Only counts, versions and health are sent.
type Client struct {
	BaseURL  string
	ServerID string
	Key      ed25519.PrivateKey
	HTTP     *http.Client
	Now      func() time.Time
}

// APIError is a non-2xx console response.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("console returned %d: %s", e.Status, e.Message) }

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// do sends a signed request and returns status, headers and body (body already closed).
func (c *Client) do(ctx context.Context, serverID string, key ed25519.PrivateKey, method, path string, in any, headers map[string]string) (int, http.Header, []byte, error) {
	if !strings.HasPrefix(c.BaseURL, "https://") && !strings.HasPrefix(c.BaseURL, "http://127.0.0.1") {
		return 0, nil, nil, errors.New("console URL must be https")
	}
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return 0, nil, nil, err
		}
	}
	full := strings.TrimRight(c.BaseURL, "/") + path
	u, err := url.Parse(full)
	if err != nil {
		return 0, nil, nil, err
	}
	s, err := Sign(key, method, u.RequestURI(), serverID, c.now(), "", body)
	if err != nil {
		return 0, nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, full, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set(HeaderServer, s.ServerID)
	req.Header.Set(HeaderTimestamp, s.Timestamp)
	req.Header.Set(HeaderNonce, s.Nonce)
	req.Header.Set(HeaderSignature, s.Signature)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return 0, nil, nil, err
	}
	if resp.StatusCode >= 400 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(out, &e)
		return resp.StatusCode, resp.Header, out, &APIError{Status: resp.StatusCode, Message: e.Error}
	}
	return resp.StatusCode, resp.Header, out, nil
}

// EnrolRequest is the enrolment body (no client data).
type EnrolRequest struct {
	Code         string          `json:"code"`
	PublicKey    string          `json:"publicKey"`
	Hostname     string          `json:"hostname"`
	AgentVersion string          `json:"agentVersion"`
	Preflight    json.RawMessage `json:"preflight,omitempty"`
}

// Enrol generates a new server key, proves possession by signing the request with
// it, and returns the console-assigned server ID and the private key.
func (c *Client) Enrol(ctx context.Context, code, hostname, agentVersion string, preflight json.RawMessage) (string, ed25519.PrivateKey, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", nil, err
	}
	req := EnrolRequest{Code: strings.ToUpper(strings.TrimSpace(code)), PublicKey: base64.StdEncoding.EncodeToString(pub),
		Hostname: hostname, AgentVersion: agentVersion, Preflight: preflight}
	_, _, body, err := c.do(ctx, EnrolmentServerID, priv, http.MethodPost, "/api/agent/enroll", req, nil)
	if err != nil {
		return "", nil, err
	}
	var out struct {
		ServerID string `json:"serverId"`
	}
	if err := json.Unmarshal(body, &out); err != nil || !strings.HasPrefix(out.ServerID, "srv_") {
		return "", nil, errors.New("unexpected enrolment response")
	}
	return out.ServerID, priv, nil
}

// Heartbeat is the 15-minute status report.
type Heartbeat struct {
	AgentVersion    string `json:"agentVersion"`
	OpenClawVersion string `json:"openclawVersion,omitempty"`
	DeskVersion     string `json:"deskVersion,omitempty"`
	StagedVersion   string `json:"stagedVersion,omitempty"`
	Health          string `json:"health"`
	ActiveSeats     int    `json:"activeSeats"`
}

// HeartbeatReply is what the console tells the agent.
type HeartbeatReply struct {
	FirmStatus       string `json:"firmStatus"`
	OfflineGraceDays int    `json:"offlineGraceDays"`
	PolicyVersion    int    `json:"policyVersion"`
	ServerTime       string `json:"serverTime"`
}

// SendHeartbeat posts a heartbeat.
func (c *Client) SendHeartbeat(ctx context.Context, hb Heartbeat) (HeartbeatReply, error) {
	_, _, body, err := c.do(ctx, c.ServerID, c.Key, http.MethodPost, "/api/agent/heartbeat", hb, nil)
	if err != nil {
		return HeartbeatReply{}, err
	}
	var r HeartbeatReply
	return r, json.Unmarshal(body, &r)
}

// PolicyEmployee is one employee in the firm policy.
type PolicyEmployee struct {
	EmployeeID string   `json:"employeeId"`
	SID        string   `json:"sid"`
	Name       string   `json:"name"`
	Status     string   `json:"status"`
	Packs      []string `json:"packs"`
	// TOTPResetAt is when an admin last asked to reset this employee's authenticator (ADR-049).
	TOTPResetAt string `json:"totpResetAt,omitempty"`
	// Admin marks an employee who is also a firm admin (admin-only notices, ADR-052).
	Admin bool `json:"admin,omitempty"`
	// TaskRole: which task buttons Desk shows first (ADR-061).
	TaskRole string `json:"taskRole,omitempty"`
}

// Policy is the firm policy document.
type Policy struct {
	PolicyVersion int              `json:"policyVersion"`
	Policy        json.RawMessage  `json:"policy"`
	ADGroupGrants json.RawMessage  `json:"adGroupGrants"`
	Employees     []PolicyEmployee `json:"employees"`
}

// FetchPolicy gets the policy; notModified is true when etag still matches.
func (c *Client) FetchPolicy(ctx context.Context, etag string) (p Policy, newETag string, notModified bool, err error) {
	h := map[string]string{}
	if etag != "" {
		h["If-None-Match"] = etag
	}
	status, hdr, body, err := c.do(ctx, c.ServerID, c.Key, http.MethodGet, "/api/agent/policy", nil, h)
	if err != nil {
		return Policy{}, "", false, err
	}
	if status == http.StatusNotModified {
		return Policy{}, etag, true, nil
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return Policy{}, "", false, err
	}
	return p, hdr.Get("ETag"), false, nil
}

// AuditCount is a console-bound count (no targets, no paths).
type AuditCount struct {
	Category string `json:"category"`
	Count    int    `json:"count"`
}

// SendAuditSummary posts one day's counts.
func (c *Client) SendAuditSummary(ctx context.Context, date string, counts []AuditCount) error {
	if counts == nil {
		counts = []AuditCount{}
	}
	_, _, _, err := c.do(ctx, c.ServerID, c.Key, http.MethodPost, "/api/agent/audit-summary",
		map[string]any{"date": date, "counts": counts}, nil)
	return err
}

// AssignedRelease is the console's answer to GET /api/agent/releases.
type AssignedRelease struct {
	Version       string `json:"version"`
	Severity      string `json:"severity"`
	DeadlineAt    string `json:"deadlineAt"` // RFC 3339; empty unless a security release has one
	ManifestURL   string `json:"manifestUrl"`
	PayloadSHA256 string `json:"payloadSha256"`
	KeyID         string `json:"keyId"`
}

// FetchRelease asks which release this server should stage (nil = none).
func (c *Client) FetchRelease(ctx context.Context) (*AssignedRelease, error) {
	_, _, body, err := c.do(ctx, c.ServerID, c.Key, http.MethodGet, "/api/agent/releases", nil, nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		Release *AssignedRelease `json:"release"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Release, nil
}

// BindReply is the console's answer to a bind (ADR-044).
type BindReply struct {
	EmployeeID string   `json:"employeeId"`
	Name       string   `json:"name"`
	Status     string   `json:"status"`
	Packs      []string `json:"packs"`
}

// Bind redeems an employee's one-time code for sid, the caller SID the pipe read
// from the OS (rule 4).
func (c *Client) Bind(ctx context.Context, code, sid string) (BindReply, error) {
	_, _, body, err := c.do(ctx, c.ServerID, c.Key, http.MethodPost, "/api/agent/bind",
		map[string]string{"code": code, "sid": sid}, nil)
	if err != nil {
		return BindReply{}, err
	}
	var r BindReply
	return r, json.Unmarshal(body, &r)
}

// SubmitSupport uploads a Report-a-problem bundle (ADR-050) and returns the ticket reference.
func (c *Client) SubmitSupport(ctx context.Context, employeeID, description string, bundle map[string]any) (string, error) {
	_, _, body, err := c.do(ctx, c.ServerID, c.Key, http.MethodPost, "/api/agent/support",
		map[string]any{"employeeId": employeeID, "description": description, "bundle": bundle}, nil)
	if err != nil {
		return "", err
	}
	var r struct {
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(body, &r); err != nil || r.Ticket == "" {
		return "", errors.New("console returned no ticket")
	}
	return r.Ticket, nil
}

// UsageCount is one employee's counts for a day (ADR-051). No text, ever.
type UsageCount struct {
	EmployeeID   string `json:"employeeId"`
	Turns        int64  `json:"turns"`
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
}

// SendUsage uploads one day's per-employee usage counts.
func (c *Client) SendUsage(ctx context.Context, date string, counts []UsageCount) error {
	if counts == nil {
		counts = []UsageCount{}
	}
	_, _, _, err := c.do(ctx, c.ServerID, c.Key, http.MethodPost, "/api/agent/usage",
		map[string]any{"date": date, "employees": counts}, nil)
	return err
}

// ConsoleNotice is one active notice from GET /api/agent/notices.
type ConsoleNotice struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Audience string `json:"audience"`
	Title    string `json:"title"`
	Body     string `json:"body"`
	StartsAt string `json:"startsAt"`
}

// FetchNotices returns the firm's active notices; anything malformed is dropped.
func (c *Client) FetchNotices(ctx context.Context) ([]ConsoleNotice, error) {
	_, _, body, err := c.do(ctx, c.ServerID, c.Key, http.MethodGet, "/api/agent/notices", nil, nil)
	if err != nil {
		return nil, err
	}
	var r struct {
		Notices []ConsoleNotice `json:"notices"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	out := make([]ConsoleNotice, 0, len(r.Notices))
	for _, n := range r.Notices {
		kindOK := n.Kind == "update" || n.Kind == "billing" || n.Kind == "admin"
		audOK := n.Audience == "all" || n.Audience == "admins"
		if kindOK && audOK && len(n.ID) == 36 && n.Title != "" && len(n.Title) <= 400 && len(n.Body) <= 2000 {
			out = append(out, n)
		}
	}
	return out, nil
}
