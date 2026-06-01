use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type DeviceId = Uuid;
pub type AiSessionId = Uuid;
pub type ProjectId = Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub session_id: String,
    pub name: String,
    pub backend: TerminalBackend,
    pub tool: AiTool,
    pub status: SessionStatus,
    pub cwd: Option<String>,
    pub recent_output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalBackend {
    Tmux,
    Screen,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiTool {
    Codex,
    Claude,
    Gemini,
    Deepseek,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Running,
    Missing,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlInput {
    CtrlC,
    CtrlD,
    Enter,
    ArrowUp,
    ArrowDown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputKind {
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TerminalErrorCode {
    SessionNotFound,
    DesktopOffline,
    RiskConfirmationRequired,
    UnsupportedBackend,
    CommandRejected,
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderDefinition {
    pub id: String,
    pub name: String,
    pub command: String,
    pub built_in: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderAuthStatus {
    Unknown,
    SignedIn,
    SignedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProviderStatus {
    pub provider_id: String,
    pub installed: bool,
    pub version: Option<String>,
    pub auth_status: ProviderAuthStatus,
    pub last_checked_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: ProjectId,
    pub device_id: DeviceId,
    pub name: String,
    pub path: String,
    pub git_branch: Option<String>,
    pub git_dirty: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionStatus {
    Running,
    Idle,
    Completed,
    Failed,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSession {
    pub id: AiSessionId,
    pub user_id: Uuid,
    pub device_id: DeviceId,
    pub project_id: Option<ProjectId>,
    pub provider_id: String,
    pub terminal_session_id: Option<String>,
    pub title: String,
    pub status: AiSessionStatus,
    pub summary: Option<String>,
    pub archived_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiMessageRole {
    User,
    Assistant,
    System,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiHistoryMessage {
    pub role: AiMessageRole,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSnapshot {
    pub device_id: DeviceId,
    pub project_id: ProjectId,
    pub branch: Option<String>,
    pub dirty: bool,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum RealtimeMessage {
    #[serde(rename = "desktop.heartbeat")]
    #[serde(rename_all = "camelCase")]
    DesktopHeartbeat {
        device_id: DeviceId,
        timestamp: DateTime<Utc>,
    },

    #[serde(rename = "sessions.snapshot")]
    #[serde(rename_all = "camelCase")]
    SessionsSnapshot {
        device_id: DeviceId,
        sessions: Vec<TerminalSession>,
    },

    #[serde(rename = "terminal.input")]
    #[serde(rename_all = "camelCase")]
    TerminalInput {
        device_id: DeviceId,
        session_id: String,
        input: String,
        input_kind: InputKind,
        confirmed_risk: bool,
    },

    #[serde(rename = "terminal.control")]
    #[serde(rename_all = "camelCase")]
    TerminalControl {
        device_id: DeviceId,
        session_id: String,
        control: ControlInput,
    },

    #[serde(rename = "terminal.output")]
    #[serde(rename_all = "camelCase")]
    TerminalOutput {
        device_id: DeviceId,
        session_id: String,
        chunk: String,
        sequence: i64,
    },

    #[serde(rename = "terminal.error")]
    #[serde(rename_all = "camelCase")]
    TerminalError {
        device_id: DeviceId,
        session_id: Option<String>,
        code: TerminalErrorCode,
        message: String,
    },

    #[serde(rename = "providers.snapshot")]
    #[serde(rename_all = "camelCase")]
    ProvidersSnapshot {
        device_id: DeviceId,
        providers: Vec<DesktopProviderStatus>,
    },

    #[serde(rename = "projects.snapshot")]
    #[serde(rename_all = "camelCase")]
    ProjectsSnapshot {
        device_id: DeviceId,
        projects: Vec<WorkspaceProject>,
    },

    #[serde(rename = "ai.sessions.snapshot")]
    #[serde(rename_all = "camelCase")]
    AiSessionsSnapshot {
        device_id: DeviceId,
        sessions: Vec<AiSession>,
    },

    #[serde(rename = "ai.session.create")]
    #[serde(rename_all = "camelCase")]
    AiSessionCreate {
        device_id: DeviceId,
        request_id: Uuid,
        provider_id: String,
        project_id: Option<ProjectId>,
        project_path: Option<String>,
        title: String,
        creation_mode: String,
        terminal_session_id: Option<String>,
    },

    #[serde(rename = "ai.message.send")]
    #[serde(rename_all = "camelCase")]
    AiMessageSend {
        device_id: DeviceId,
        ai_session_id: AiSessionId,
        content: String,
        confirmed_risk: bool,
    },

    #[serde(rename = "ai.message.delta")]
    #[serde(rename_all = "camelCase")]
    AiMessageDelta {
        device_id: DeviceId,
        ai_session_id: AiSessionId,
        content: String,
        sequence: i64,
    },

    #[serde(rename = "ai.message.done")]
    #[serde(rename_all = "camelCase")]
    AiMessageDone {
        device_id: DeviceId,
        ai_session_id: AiSessionId,
        status: AiSessionStatus,
        summary: Option<String>,
    },

    #[serde(rename = "ai.history.request")]
    #[serde(rename_all = "camelCase")]
    AiHistoryRequest {
        device_id: DeviceId,
        ai_session_id: AiSessionId,
        request_id: Uuid,
    },

    #[serde(rename = "ai.history.response")]
    #[serde(rename_all = "camelCase")]
    AiHistoryResponse {
        device_id: DeviceId,
        ai_session_id: AiSessionId,
        request_id: Uuid,
        messages: Vec<AiHistoryMessage>,
    },

    #[serde(rename = "git.status.snapshot")]
    #[serde(rename_all = "camelCase")]
    GitStatusSnapshot { snapshot: GitStatusSnapshot },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiskAssessment {
    pub risky: bool,
    pub matched_rules: Vec<&'static str>,
}

impl RiskAssessment {
    pub fn safe() -> Self {
        Self {
            risky: false,
            matched_rules: Vec::new(),
        }
    }
}

pub fn assess_command_risk(input: &str) -> RiskAssessment {
    let lowered = input.to_ascii_lowercase();
    let rules = [
        ("rm -rf", "rm -rf"),
        ("sudo rm", "sudo rm"),
        ("mkfs", "mkfs"),
        ("shutdown", "shutdown"),
        ("reboot", "reboot"),
        ("dd if=", "dd if="),
        ("chmod -r 777", "chmod -R 777"),
        (".ssh", ".ssh"),
        ("id_rsa", "id_rsa"),
        ("private key", "private key"),
        ("export token=", "export TOKEN="),
        ("export secret=", "export SECRET="),
        ("api_key=", "api_key="),
        ("apikey=", "apikey="),
        ("access_token=", "access_token="),
    ];

    let matched_rules = rules
        .into_iter()
        .filter_map(|(needle, label)| lowered.contains(needle).then_some(label))
        .collect::<Vec<_>>();

    RiskAssessment {
        risky: !matched_rules.is_empty(),
        matched_rules,
    }
}

pub fn detect_ai_tool(name_or_output: &str) -> AiTool {
    let value = name_or_output.to_ascii_lowercase();
    if value.contains("codex") {
        AiTool::Codex
    } else if value.contains("claude") {
        AiTool::Claude
    } else if value.contains("gemini") {
        AiTool::Gemini
    } else if value.contains("deepseek") {
        AiTool::Deepseek
    } else {
        AiTool::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_risky_commands() {
        let risk = assess_command_risk("sudo rm -rf ~/.ssh");
        assert!(risk.risky);
        assert!(risk.matched_rules.contains(&"rm -rf"));
        assert!(risk.matched_rules.contains(&"sudo rm"));
        assert!(risk.matched_rules.contains(&".ssh"));
    }

    #[test]
    fn leaves_normal_prompts_safe() {
        let risk = assess_command_risk("please review this project");
        assert!(!risk.risky);
    }

    #[test]
    fn serializes_protocol_type_names() {
        let msg = RealtimeMessage::TerminalControl {
            device_id: Uuid::nil(),
            session_id: "tmux:codex".to_string(),
            control: ControlInput::CtrlC,
        };
        let json = serde_json::to_value(msg).unwrap();
        assert_eq!(json["type"], "terminal.control");
        assert_eq!(json["sessionId"], "tmux:codex");
        assert_eq!(json["control"], "ctrl_c");
    }

    #[test]
    fn serializes_ai_protocol_type_names() {
        let msg = RealtimeMessage::AiMessageSend {
            device_id: Uuid::nil(),
            ai_session_id: Uuid::nil(),
            content: "hello".to_string(),
            confirmed_risk: false,
        };
        let json = serde_json::to_value(msg).unwrap();
        assert_eq!(json["type"], "ai.message.send");
        assert_eq!(json["aiSessionId"], Uuid::nil().to_string());
    }
}
