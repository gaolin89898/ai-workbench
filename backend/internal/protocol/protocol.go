// Ported from crates/shared/src/lib.rs.
// This package mirrors the wire protocol types used between the relay server
// and the desktop/mobile clients. Field names and JSON tags are kept
// camelCase to stay wire-compatible with the existing Rust serde layout.
package protocol

import (
	"encoding/json"
	"fmt"
	"time"
)

// Message is the common interface implemented by every realtime message
// variant. Each concrete struct carries a "type" discriminator field that
// GetType returns.
type Message interface {
	GetType() string
}

// BaseMessage is embedded by every message struct to provide the shared
// "type" discriminator and a default GetType implementation.
type BaseMessage struct {
	Type string `json:"type"`
}

// GetType implements Message.
func (b BaseMessage) GetType() string { return b.Type }

// ProviderAuthStatus mirrors the Rust ProviderAuthStatus enum (lowercase).
type ProviderAuthStatus string

const (
	ProviderAuthUnknown    ProviderAuthStatus = "unknown"
	ProviderAuthSignedIn   ProviderAuthStatus = "signedIn"
	ProviderAuthSignedOut  ProviderAuthStatus = "signedOut"
)

// AiSessionStatus mirrors the Rust AiSessionStatus enum (lowercase).
type AiSessionStatus string

const (
	AiSessionRunning   AiSessionStatus = "running"
	AiSessionIdle      AiSessionStatus = "idle"
	AiSessionCompleted AiSessionStatus = "completed"
	AiSessionFailed    AiSessionStatus = "failed"
	AiSessionMissing   AiSessionStatus = "missing"
)

// AiMessageRole mirrors the Rust AiMessageRole enum (lowercase).
type AiMessageRole string

const (
	AiMessageRoleUser      AiMessageRole = "user"
	AiMessageRoleAssistant AiMessageRole = "assistant"
	AiMessageRoleSystem    AiMessageRole = "system"
	AiMessageRoleError     AiMessageRole = "error"
)

// DesktopProviderStatus mirrors the shared DesktopProviderStatus struct.
type DesktopProviderStatus struct {
	ProviderId    string             `json:"providerId"`
	Installed     bool               `json:"installed"`
	Version       *string            `json:"version"`
	AuthStatus    ProviderAuthStatus `json:"authStatus"`
	LastCheckedAt time.Time          `json:"lastCheckedAt"`
}

// WorkspaceProject mirrors the shared WorkspaceProject struct.
type WorkspaceProject struct {
	Id        string    `json:"id"`
	DeviceId  string    `json:"deviceId"`
	Name      string    `json:"name"`
	Path      string    `json:"path"`
	GitBranch *string   `json:"gitBranch"`
	GitDirty  bool      `json:"gitDirty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// AiSession mirrors the shared AiSession struct.
type AiSession struct {
	Id                 string         `json:"id"`
	UserId             string         `json:"userId"`
	DeviceId           string         `json:"deviceId"`
	ProjectId          *string        `json:"projectId"`
	ProviderId         string         `json:"providerId"`
	TerminalSessionId  *string        `json:"terminalSessionId"`
	ProviderSessionId  *string        `json:"providerSessionId"`
	Title              string         `json:"title"`
	Status             AiSessionStatus `json:"status"`
	Summary            *string        `json:"summary"`
	ArchivedAt         *time.Time     `json:"archivedAt"`
	UpdatedAt          time.Time      `json:"updatedAt"`
}

// AiHistoryMessage mirrors the shared AiHistoryMessage struct.
type AiHistoryMessage struct {
	Role      AiMessageRole `json:"role"`
	Content   string        `json:"content"`
	CreatedAt time.Time     `json:"createdAt"`
}

// ChatSegment mirrors the shared ChatSegment struct. The Rust field
// segment_type is renamed to "type" on the wire, so the Go field is Type.
type ChatSegment struct {
	Type       string  `json:"type"`
	StepId     *string `json:"stepId"`
	Text       *string `json:"text"`
	Label      *string `json:"label"`
	Detail     *string `json:"detail"`
	Icon       *string `json:"icon"`
	Additions  *int64  `json:"additions"`
	Deletions  *int64  `json:"deletions"`
	Title      *string `json:"title"`
	Collapsed  *bool   `json:"collapsed"`
	DurationMs *int64  `json:"durationMs"`
	ToolName   *string `json:"toolName"`
	Command    *string `json:"command"`
	Status     *string `json:"status"`
	Summary    *string `json:"summary"`
	Input      *string `json:"input"`
	Output     *string `json:"output"`
	Message    *string `json:"message"`
}

// GitStatusSnapshot mirrors the shared GitStatusSnapshot struct (the payload
// wrapped by the git.status.snapshot message variant).
type GitStatusSnapshot struct {
	DeviceId  string   `json:"deviceId"`
	ProjectId string   `json:"projectId"`
	Branch    *string  `json:"branch"`
	Dirty     bool     `json:"dirty"`
	Files     []string `json:"files"`
}

// ---- Realtime message variants (RealtimeMessage enum in lib.rs) ----

// DesktopHeartbeat: "desktop.heartbeat".
type DesktopHeartbeat struct {
	BaseMessage
	DeviceId  string    `json:"deviceId"`
	Timestamp time.Time `json:"timestamp"`
}

// ProvidersSnapshot: "providers.snapshot".
type ProvidersSnapshot struct {
	BaseMessage
	DeviceId  string                  `json:"deviceId"`
	Providers []DesktopProviderStatus `json:"providers"`
}

// ProjectsSnapshot: "projects.snapshot".
type ProjectsSnapshot struct {
	BaseMessage
	DeviceId string             `json:"deviceId"`
	Projects []WorkspaceProject `json:"projects"`
}

// AiSessionsSnapshot: "ai.sessions.snapshot".
type AiSessionsSnapshot struct {
	BaseMessage
	DeviceId string     `json:"deviceId"`
	Sessions []AiSession `json:"sessions"`
}

// AiSessionCreate: "ai.session.create".
type AiSessionCreate struct {
	BaseMessage
	DeviceId          string  `json:"deviceId"`
	RequestId         string  `json:"requestId"`
	AiSessionId       string  `json:"aiSessionId"`
	ProviderId        string  `json:"providerId"`
	ProjectId         *string `json:"projectId"`
	ProjectPath       *string `json:"projectPath"`
	Title             string  `json:"title"`
	CreationMode      string  `json:"creationMode"`
	TerminalSessionId *string `json:"terminalSessionId"`
}

// AiMessageSend: "ai.message.send".
type AiMessageSend struct {
	BaseMessage
	DeviceId      string `json:"deviceId"`
	AiSessionId   string `json:"aiSessionId"`
	Content       string `json:"content"`
	ConfirmedRisk bool   `json:"confirmedRisk"`
}

// AiMessageDelta: "ai.message.delta".
// NOTE: the Rust source names this field `content` (not `delta`); kept as-is
// for wire compatibility.
type AiMessageDelta struct {
	BaseMessage
	DeviceId    string `json:"deviceId"`
	AiSessionId string `json:"aiSessionId"`
	Content     string `json:"content"`
	Sequence    int64  `json:"sequence"`
}

// AiMessageDone: "ai.message.done".
type AiMessageDone struct {
	BaseMessage
	DeviceId    string         `json:"deviceId"`
	AiSessionId string         `json:"aiSessionId"`
	Status      AiSessionStatus `json:"status"`
	Summary     *string        `json:"summary"`
}

// AiHistoryRequest: "ai.history.request".
type AiHistoryRequest struct {
	BaseMessage
	DeviceId    string `json:"deviceId"`
	AiSessionId string `json:"aiSessionId"`
	RequestId   string `json:"requestId"`
}

// AiHistoryResponse: "ai.history.response".
type AiHistoryResponse struct {
	BaseMessage
	DeviceId    string            `json:"deviceId"`
	AiSessionId string            `json:"aiSessionId"`
	RequestId   string            `json:"requestId"`
	Messages    []AiHistoryMessage `json:"messages"`
}

// AiChatOutput: "ai.chat.output".
type AiChatOutput struct {
	BaseMessage
	DeviceId    string       `json:"deviceId"`
	AiSessionId string       `json:"aiSessionId"`
	Kind        string       `json:"kind"`
	Text        *string      `json:"text"`
	StepId      *string      `json:"stepId"`
	Segment     *ChatSegment `json:"segment"`
}

// AiSessionArchive: "ai.session.archive".
type AiSessionArchive struct {
	BaseMessage
	DeviceId    string `json:"deviceId"`
	AiSessionId string `json:"aiSessionId"`
	Archived    bool   `json:"archived"`
}

// GitStatusSnapshotMessage: "git.status.snapshot".
// The Rust variant wraps a `snapshot` field of type GitStatusSnapshot; the
// message struct is named with a Message suffix to avoid clashing with the
// payload struct above.
type GitStatusSnapshotMessage struct {
	BaseMessage
	Snapshot GitStatusSnapshot `json:"snapshot"`
}

// ParseMessage decodes a JSON object into the concrete Message variant based
// on its "type" discriminator. Unknown types yield an error.
func ParseMessage(data []byte) (Message, error) {
	var base struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &base); err != nil {
		return nil, err
	}
	switch base.Type {
	case "desktop.heartbeat":
		var m DesktopHeartbeat
		err := json.Unmarshal(data, &m)
		return m, err
	case "providers.snapshot":
		var m ProvidersSnapshot
		err := json.Unmarshal(data, &m)
		return m, err
	case "projects.snapshot":
		var m ProjectsSnapshot
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.sessions.snapshot":
		var m AiSessionsSnapshot
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.session.create":
		var m AiSessionCreate
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.message.send":
		var m AiMessageSend
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.message.delta":
		var m AiMessageDelta
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.message.done":
		var m AiMessageDone
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.history.request":
		var m AiHistoryRequest
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.history.response":
		var m AiHistoryResponse
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.chat.output":
		var m AiChatOutput
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.session.archive":
		var m AiSessionArchive
		err := json.Unmarshal(data, &m)
		return m, err
	case "git.status.snapshot":
		var m GitStatusSnapshotMessage
		err := json.Unmarshal(data, &m)
		return m, err
	default:
		return nil, fmt.Errorf("unknown message type: %s", base.Type)
	}
}

// MarshalMessage serializes a Message back to JSON.
func MarshalMessage(msg Message) ([]byte, error) {
	return json.Marshal(msg)
}

// Compile-time assertions that every message struct satisfies Message.
var (
	_ Message = DesktopHeartbeat{}
	_ Message = ProvidersSnapshot{}
	_ Message = ProjectsSnapshot{}
	_ Message = AiSessionsSnapshot{}
	_ Message = AiSessionCreate{}
	_ Message = AiMessageSend{}
	_ Message = AiMessageDelta{}
	_ Message = AiMessageDone{}
	_ Message = AiHistoryRequest{}
	_ Message = AiHistoryResponse{}
	_ Message = AiChatOutput{}
	_ Message = AiSessionArchive{}
	_ Message = GitStatusSnapshotMessage{}
)
