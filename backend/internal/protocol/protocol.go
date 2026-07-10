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
	ProviderAuthUnknown   ProviderAuthStatus = "unknown"
	ProviderAuthSignedIn  ProviderAuthStatus = "signedIn"
	ProviderAuthSignedOut ProviderAuthStatus = "signedOut"
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

type WorkspaceFileEntry struct {
	Name       string    `json:"name"`
	Path       string    `json:"path"`
	Kind       string    `json:"kind"`
	Size       int64     `json:"size"`
	ModifiedAt time.Time `json:"modifiedAt"`
}

type ProjectFilePreview struct {
	Name        string    `json:"name"`
	Path        string    `json:"path"`
	Size        int64     `json:"size"`
	ModifiedAt  time.Time `json:"modifiedAt"`
	PreviewKind string    `json:"previewKind"`
	MimeType    string    `json:"mimeType,omitempty"`
	Content     string    `json:"content,omitempty"`
	DataUrl     string    `json:"dataUrl,omitempty"`
	Language    string    `json:"language,omitempty"`
}

// AiSession mirrors the shared AiSession struct.
type AiSession struct {
	Id                string          `json:"id"`
	UserId            string          `json:"userId"`
	DeviceId          string          `json:"deviceId"`
	ProjectId         *string         `json:"projectId"`
	ProviderId        string          `json:"providerId"`
	TerminalSessionId *string         `json:"terminalSessionId"`
	ProviderSessionId *string         `json:"providerSessionId"`
	Title             string          `json:"title"`
	Status            AiSessionStatus `json:"status"`
	Summary           *string         `json:"summary"`
	ArchivedAt        *time.Time      `json:"archivedAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
}

// AiHistoryMessage mirrors the shared AiHistoryMessage struct.
type AiHistoryMessage struct {
	Role      AiMessageRole `json:"role"`
	Content   any           `json:"content"`
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
	DeviceId string      `json:"deviceId"`
	Sessions []AiSession `json:"sessions"`
}

// ProjectCreated: "project.created". Pushed by the server to the desktop
// when a mobile client creates a workspace project via HTTP, so the desktop
// can register it locally without waiting for the next 10s snapshot.
type ProjectCreated struct {
	BaseMessage
	DeviceId string           `json:"deviceId"`
	Project  WorkspaceProject `json:"project"`
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
	DeviceId        string `json:"deviceId"`
	AiSessionId     string `json:"aiSessionId"`
	Content         string `json:"content"`
	ConfirmedRisk   bool   `json:"confirmedRisk"`
	Model           string `json:"model,omitempty"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
	Mode            string `json:"mode,omitempty"`
	Goal            string `json:"goal,omitempty"`
}

type ProjectFilesRequest struct {
	BaseMessage
	DeviceId      string  `json:"deviceId"`
	ProjectId     string  `json:"projectId"`
	ProjectPath   string  `json:"projectPath"`
	DirectoryPath *string `json:"directoryPath"`
	RequestId     string  `json:"requestId"`
}

type ProjectFilesResponse struct {
	BaseMessage
	DeviceId  string               `json:"deviceId"`
	ProjectId string               `json:"projectId"`
	RequestId string               `json:"requestId"`
	Entries   []WorkspaceFileEntry `json:"entries"`
	Error     *string              `json:"error"`
}

type ProjectFilePreviewRequest struct {
	BaseMessage
	DeviceId    string `json:"deviceId"`
	ProjectId   string `json:"projectId"`
	ProjectPath string `json:"projectPath"`
	FilePath    string `json:"filePath"`
	RequestId   string `json:"requestId"`
}

type ProjectFilePreviewResponse struct {
	BaseMessage
	DeviceId  string              `json:"deviceId"`
	ProjectId string              `json:"projectId"`
	RequestId string              `json:"requestId"`
	Preview   *ProjectFilePreview `json:"preview"`
	Error     *string             `json:"error"`
}

// AiMessageStop: "ai.message.stop".
type AiMessageStop struct {
	BaseMessage
	DeviceId    string `json:"deviceId"`
	AiSessionId string `json:"aiSessionId"`
}

type AiRunModelOption struct {
	Id          string `json:"id"`
	Model       string `json:"model"`
	DisplayName string `json:"displayName"`
	Description string `json:"description,omitempty"`
	IsDefault   bool   `json:"isDefault,omitempty"`
}

type AiRunProviderSettings struct {
	ProviderId       string             `json:"providerId"`
	Model            string             `json:"model,omitempty"`
	ReasoningEffort  string             `json:"reasoningEffort,omitempty"`
	Models           []AiRunModelOption `json:"models,omitempty"`
	ReasoningOptions []string           `json:"reasoningOptions,omitempty"`
}

// AiRunSettingsSnapshot: "ai.run.settings.snapshot".
type AiRunSettingsSnapshot struct {
	BaseMessage
	DeviceId string                `json:"deviceId"`
	Codex    AiRunProviderSettings `json:"codex"`
	Claude   AiRunProviderSettings `json:"claude"`
	OpenCode AiRunProviderSettings `json:"opencode"`
	MiMo     AiRunProviderSettings `json:"mimo"`
}

// AiRunSettingsUpdate: "ai.run.settings.update".
type AiRunSettingsUpdate struct {
	BaseMessage
	DeviceId        string `json:"deviceId"`
	ProviderId      string `json:"providerId"`
	Model           string `json:"model,omitempty"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

// AiApprovalRespond: "ai.approval.respond".
type AiApprovalRespond struct {
	BaseMessage
	DeviceId    string `json:"deviceId"`
	AiSessionId string `json:"aiSessionId"`
	ApprovalId  string `json:"approvalId"`
	Decision    string `json:"decision"`
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
	DeviceId    string          `json:"deviceId"`
	AiSessionId string          `json:"aiSessionId"`
	Status      AiSessionStatus `json:"status"`
	Summary     *string         `json:"summary"`
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
	DeviceId    string             `json:"deviceId"`
	AiSessionId string             `json:"aiSessionId"`
	RequestId   string             `json:"requestId"`
	Messages    []AiHistoryMessage `json:"messages"`
	Trace       json.RawMessage    `json:"trace,omitempty"`
}

// AiChatOutput: "ai.chat.output".
type AiChatOutput struct {
	BaseMessage
	DeviceId    string        `json:"deviceId"`
	AiSessionId string        `json:"aiSessionId"`
	Kind        string        `json:"kind"`
	Text        *string       `json:"text"`
	StepId      *string       `json:"stepId"`
	Segment     *ChatSegment  `json:"segment"`
	Segments    []ChatSegment `json:"segments"`
}

// AiTraceUpdate: "ai.trace.update".
type AiTraceUpdate struct {
	BaseMessage
	DeviceId    string          `json:"deviceId"`
	AiSessionId string          `json:"aiSessionId"`
	Trace       json.RawMessage `json:"trace"`
}

// AiSessionArchive: "ai.session.archive".
type AiSessionArchive struct {
	BaseMessage
	DeviceId    string `json:"deviceId"`
	AiSessionId string `json:"aiSessionId"`
	Archived    bool   `json:"archived"`
}

// AiSessionRename: "ai.session.rename". 由 HTTP PATCH /ai-sessions/{id} 触发，
// forward 到桌面端让本地 SQLite 同步更新 title。
type AiSessionRename struct {
	BaseMessage
	DeviceId    string `json:"deviceId"`
	AiSessionId string `json:"aiSessionId"`
	Title       string `json:"title"`
}

// AppUpdateAvailable: "app.update.available". Sent by the server to online
// desktop/mobile clients when an administrator publishes update metadata.
type AppUpdateAvailable struct {
	BaseMessage
	Platform            string  `json:"platform"`
	CurrentVersion      string  `json:"currentVersion,omitempty"`
	LatestVersion       string  `json:"latestVersion"`
	MinSupportedVersion *string `json:"minSupportedVersion"`
	Available           bool    `json:"available"`
	Required            bool    `json:"required"`
	Force               bool    `json:"force"`
	DownloadUrl         *string `json:"downloadUrl"`
	WindowsDownloadUrl  *string `json:"windowsDownloadUrl"`
	LinuxDownloadUrl    *string `json:"linuxDownloadUrl"`
	ReleaseUrl          *string `json:"releaseUrl"`
	ReleaseNotes        *string `json:"releaseNotes"`
	Source              string  `json:"source"`
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
	case "project.files.request":
		var m ProjectFilesRequest
		err := json.Unmarshal(data, &m)
		return m, err
	case "project.files.response":
		var m ProjectFilesResponse
		err := json.Unmarshal(data, &m)
		return m, err
	case "project.file.preview.request":
		var m ProjectFilePreviewRequest
		err := json.Unmarshal(data, &m)
		return m, err
	case "project.file.preview.response":
		var m ProjectFilePreviewResponse
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.sessions.snapshot":
		var m AiSessionsSnapshot
		err := json.Unmarshal(data, &m)
		return m, err
	case "project.created":
		var m ProjectCreated
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
	case "ai.message.stop":
		var m AiMessageStop
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.run.settings.snapshot":
		var m AiRunSettingsSnapshot
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.run.settings.update":
		var m AiRunSettingsUpdate
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.approval.respond":
		var m AiApprovalRespond
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
	case "ai.trace.update":
		var m AiTraceUpdate
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.session.archive":
		var m AiSessionArchive
		err := json.Unmarshal(data, &m)
		return m, err
	case "ai.session.rename":
		var m AiSessionRename
		err := json.Unmarshal(data, &m)
		return m, err
	case "app.update.available":
		var m AppUpdateAvailable
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
	_ Message = AiMessageStop{}
	_ Message = AiRunSettingsSnapshot{}
	_ Message = AiRunSettingsUpdate{}
	_ Message = AiApprovalRespond{}
	_ Message = AiMessageDelta{}
	_ Message = AiMessageDone{}
	_ Message = AiHistoryRequest{}
	_ Message = AiHistoryResponse{}
	_ Message = AiChatOutput{}
	_ Message = AiTraceUpdate{}
	_ Message = AiSessionArchive{}
	_ Message = AiSessionRename{}
	_ Message = GitStatusSnapshotMessage{}
)
