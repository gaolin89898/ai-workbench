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

// UserOauthIdentity maps the `user_oauth_identities` table (migration 0008).
// One user may bind multiple providers; (provider, external_id) is unique.
type UserOauthIdentity struct {
	Id          string    `json:"id" db:"id"`
	UserId      string    `json:"userId" db:"user_id"`
	Provider    string    `json:"provider" db:"provider"`
	ExternalId  string    `json:"externalId" db:"external_id"`
	DisplayName string    `json:"displayName" db:"display_name"`
	CreatedAt   time.Time `json:"createdAt" db:"created_at"`
}

// OauthState maps the `oauth_states` table (migration 0016). Used by the
// GitHub "backend-relay + poll" flow: a state row is created when the client
// starts OAuth, updated when GitHub calls back, and read by the polling client.
type OauthState struct {
	Id           string     `json:"id" db:"id"`
	State        string     `json:"state" db:"state"`
	Status       string     `json:"status" db:"status"` // pending / done / error
	UserId       *string    `json:"userId" db:"user_id"`
	AccessToken  *string    `json:"accessToken" db:"access_token"`
	RefreshToken *string    `json:"refreshToken" db:"refresh_token"`
	Error        *string    `json:"error" db:"error"`
	CreatedAt    time.Time  `json:"createdAt" db:"created_at"`
	CompletedAt *time.Time `json:"completedAt" db:"completed_at"`
	ExpiresAt    time.Time  `json:"expiresAt" db:"expires_at"`
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

// TokenUsage maps the `token_usage` table. 每条记录对应一次 AI turn 的 token 消耗。
type TokenUsage struct {
	Id              string    `json:"id" db:"id"`
	UserId          string    `json:"userId" db:"user_id"`
	DeviceId        string    `json:"deviceId" db:"device_id"`
	AiSessionId     *string   `json:"aiSessionId" db:"ai_session_id"`
	ProviderId      string    `json:"providerId" db:"provider_id"`
	InputTokens     int32     `json:"inputTokens" db:"input_tokens"`
	CachedInputTokens int32     `json:"cachedInputTokens" db:"cached_input_tokens"`
	OutputTokens    int32     `json:"outputTokens" db:"output_tokens"`
	ReasoningTokens int32     `json:"reasoningTokens" db:"reasoning_tokens"`
	TotalTokens     int32     `json:"totalTokens" db:"total_tokens"`
	CreatedAt       time.Time `json:"createdAt" db:"created_at"`
}

// TokenUsageInsert 用于写入一条 token 用量记录。
type TokenUsageInsert struct {
	UserId          string
	DeviceId        string
	AiSessionId     *string
	ProviderId      string
	InputTokens     int32
	CachedInputTokens int32
	OutputTokens    int32
	ReasoningTokens int32
	TotalTokens     int32
}

// TokenUsageSummary 是按 provider 聚合后的统计行。
type TokenUsageSummary struct {
	ProviderId      string `json:"providerId"`
	InputTokens     int64  `json:"inputTokens"`
	CachedInputTokens int64  `json:"cachedInputTokens"`
	OutputTokens    int64  `json:"outputTokens"`
	ReasoningTokens int64  `json:"reasoningTokens"`
	TotalTokens     int64  `json:"totalTokens"`
	TurnCount       int64  `json:"turnCount"`
}

type TokenUsageDailySummary struct {
	Date            string `json:"date"`
	InputTokens     int64  `json:"inputTokens"`
	CachedInputTokens int64  `json:"cachedInputTokens"`
	OutputTokens    int64  `json:"outputTokens"`
	ReasoningTokens int64  `json:"reasoningTokens"`
	TotalTokens     int64  `json:"totalTokens"`
	TurnCount       int64  `json:"turnCount"`
}
