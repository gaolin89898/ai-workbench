// Ported from crates/server/src/models.rs and the migration SQL schema.
//
// Struct field lists are aligned with the actual PostgreSQL column set defined
// in backend/migrations/*.sql (the authoritative source for DB columns) so the
// db tag on every field corresponds to a real column and db.go can scan rows
// directly. JSON tags use camelCase to match the Rust serde rename_all =
// "camelCase" convention. UUIDs are represented as string and nullable columns
// as pointers.
package models

import (
	"encoding/json"
	"time"
)

// User maps the `users` table.
type User struct {
	Id                     string    `json:"id" db:"id"`
	Email                  string    `json:"email" db:"email"`
	PasswordHash           string    `json:"passwordHash" db:"password_hash"`
	CommandLoggingEnabled  bool      `json:"commandLoggingEnabled" db:"command_logging_enabled"`
	RiskConfirmationEnabled bool     `json:"riskConfirmationEnabled" db:"risk_confirmation_enabled"`
	OutputBufferLines      int32     `json:"outputBufferLines" db:"output_buffer_lines"`
	AutoReconnectEnabled   bool      `json:"autoReconnectEnabled" db:"auto_reconnect_enabled"`
	CreatedAt              time.Time `json:"createdAt" db:"created_at"`
}

// DesktopDevice maps the `desktop_devices` table.
type DesktopDevice struct {
	Id         string     `json:"id" db:"id"`
	UserId     string     `json:"userId" db:"user_id"`
	Name       string     `json:"name" db:"name"`
	Os         string     `json:"os" db:"os"`
	LastSeenAt *time.Time `json:"lastSeenAt" db:"last_seen_at"`
	Online     bool       `json:"online" db:"online"`
	CreatedAt  time.Time  `json:"createdAt" db:"created_at"`
}

// PairingCode maps the `pairing_codes` table.
type PairingCode struct {
	Id        string     `json:"id" db:"id"`
	UserId    string     `json:"userId" db:"user_id"`
	Code      string     `json:"code" db:"code"`
	ExpiresAt time.Time  `json:"expiresAt" db:"expires_at"`
	UsedAt    *time.Time `json:"usedAt" db:"used_at"`
	CreatedAt time.Time  `json:"createdAt" db:"created_at"`
}

// TerminalSession maps the `terminal_sessions` table.
type TerminalSession struct {
	Id           string     `json:"id" db:"id"`
	DeviceId     string     `json:"deviceId" db:"device_id"`
	SessionId    string     `json:"sessionId" db:"session_id"`
	Name         string     `json:"name" db:"name"`
	Backend      string     `json:"backend" db:"backend"`
	Tool         string     `json:"tool" db:"tool"`
	Status       string     `json:"status" db:"status"`
	Cwd          *string    `json:"cwd" db:"cwd"`
	RecentOutput *string    `json:"recentOutput" db:"recent_output"`
	UpdatedAt    time.Time  `json:"updatedAt" db:"updated_at"`
}

// AiProvider maps the `ai_providers` table. Id is TEXT (not a UUID).
type AiProvider struct {
	Id        string    `json:"id" db:"id"`
	Name      string    `json:"name" db:"name"`
	Command   string    `json:"command" db:"command"`
	BuiltIn   bool      `json:"builtIn" db:"built_in"`
	Enabled   bool      `json:"enabled" db:"enabled"`
	CreatedAt time.Time `json:"createdAt" db:"created_at"`
}

// DesktopProviderStatus maps the `desktop_provider_status` table.
type DesktopProviderStatus struct {
	Id            string     `json:"id" db:"id"`
	DeviceId      string     `json:"deviceId" db:"device_id"`
	ProviderId    string     `json:"providerId" db:"provider_id"`
	Installed     bool       `json:"installed" db:"installed"`
	Version       *string    `json:"version" db:"version"`
	AuthStatus    string     `json:"authStatus" db:"auth_status"`
	LastCheckedAt time.Time  `json:"lastCheckedAt" db:"last_checked_at"`
}

// WorkspaceProject maps the `workspace_projects` table.
type WorkspaceProject struct {
	Id        string     `json:"id" db:"id"`
	DeviceId  string     `json:"deviceId" db:"device_id"`
	Name      string     `json:"name" db:"name"`
	Path      string     `json:"path" db:"path"`
	GitBranch *string    `json:"gitBranch" db:"git_branch"`
	GitDirty  bool       `json:"gitDirty" db:"git_dirty"`
	UpdatedAt time.Time  `json:"updatedAt" db:"updated_at"`
	CreatedAt time.Time  `json:"createdAt" db:"created_at"`
}

// AiSession maps the `ai_sessions` table.
type AiSession struct {
	Id                string     `json:"id" db:"id"`
	UserId            string     `json:"userId" db:"user_id"`
	DeviceId          string     `json:"deviceId" db:"device_id"`
	ProjectId         *string    `json:"projectId" db:"project_id"`
	ProviderId        string     `json:"providerId" db:"provider_id"`
	TerminalSessionId *string    `json:"terminalSessionId" db:"terminal_session_id"`
	ProviderSessionId *string    `json:"providerSessionId" db:"provider_session_id"`
	Title             string     `json:"title" db:"title"`
	Status            string     `json:"status" db:"status"`
	Summary           *string    `json:"summary" db:"summary"`
	ArchivedAt        *time.Time `json:"archivedAt" db:"archived_at"`
	UpdatedAt         time.Time  `json:"updatedAt" db:"updated_at"`
	CreatedAt         time.Time  `json:"createdAt" db:"created_at"`
}

// ActivityLog maps the `activity_logs` table.
type ActivityLog struct {
	Id        string     `json:"id" db:"id"`
	UserId    string     `json:"userId" db:"user_id"`
	DeviceId  *string    `json:"deviceId" db:"device_id"`
	SessionId *string    `json:"sessionId" db:"session_id"`
	Kind      string     `json:"kind" db:"kind"`
	Title     string     `json:"title" db:"title"`
	Body      string     `json:"body" db:"body"`
	Risky     bool       `json:"risky" db:"risky"`
	CreatedAt time.Time  `json:"createdAt" db:"created_at"`
}

// CommandAuditLog maps the `command_audit_logs` table. MatchedRules holds the
// raw JSONB value.
type CommandAuditLog struct {
	Id            string          `json:"id" db:"id"`
	UserId        string          `json:"userId" db:"user_id"`
	DeviceId      string          `json:"deviceId" db:"device_id"`
	SessionId     string          `json:"sessionId" db:"session_id"`
	CommandSummary string         `json:"commandSummary" db:"command_summary"`
	Risky         bool            `json:"risky" db:"risky"`
	Confirmed     bool            `json:"confirmed" db:"confirmed"`
	MatchedRules  json.RawMessage `json:"matchedRules" db:"matched_rules"`
	CreatedAt     time.Time       `json:"createdAt" db:"created_at"`
}

// DesktopPairingRequest maps the `desktop_pairing_requests` table.
type DesktopPairingRequest struct {
	Id             string     `json:"id" db:"id"`
	Code           string     `json:"code" db:"code"`
	Name           string     `json:"name" db:"name"`
	Os             string     `json:"os" db:"os"`
	ApprovedUserId *string    `json:"approvedUserId" db:"approved_user_id"`
	DeviceId       *string    `json:"deviceId" db:"device_id"`
	UsedAt         *time.Time `json:"usedAt" db:"used_at"`
	ExpiresAt      time.Time  `json:"expiresAt" db:"expires_at"`
	CreatedAt      time.Time  `json:"createdAt" db:"created_at"`
}

// UserSettingsResponse mirrors the Rust UserSettingsResponse DTO returned by
// load_settings.
type UserSettingsResponse struct {
	CommandLoggingEnabled  bool  `json:"commandLoggingEnabled"`
	RiskConfirmationEnabled bool  `json:"riskConfirmationEnabled"`
	OutputBufferLines      int32 `json:"outputBufferLines"`
	AutoReconnectEnabled   bool  `json:"autoReconnectEnabled"`
}

// ActivityLogInsert mirrors the Rust ActivityLogInsert struct used by
// insert_activity_log. Pointers carry nullable columns.
type ActivityLogInsert struct {
	UserId    string
	DeviceId  *string
	SessionId *string
	Kind      string
	Title     string
	Body      string
	Risky     bool
}
