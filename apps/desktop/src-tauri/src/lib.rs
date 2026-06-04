use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use remote_term_shared::{
    detect_ai_tool, AiHistoryMessage, AiMessageRole, AiProviderDefinition, AiSession,
    AiSessionStatus, ChatSegment, DesktopProviderStatus, ProviderAuthStatus, RealtimeMessage,
    SessionStatus, TerminalBackend, TerminalSession, WorkspaceProject,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

const SHELL_TERMINAL_OUTPUT_EVENT: &str = "shell-terminal-output";
const SHELL_SESSION_STATUS_EVENT: &str = "shell-session-status";
const AI_CHAT_OUTPUT_EVENT: &str = "ai-chat-output";
const WORKSPACE_CHANGED_EVENT: &str = "workspace-changed";
const AI_HISTORY_CHANGED_EVENT: &str = "ai-history-changed";
const CLOUD_CONFIG_FILE: &str = "cloud-sync.json";

struct ShellPtySessionManager {
    sessions: Mutex<HashMap<Uuid, ShellPtySessionHandle>>,
}

struct ShellPtySessionHandle {
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    output: std::sync::Arc<Mutex<String>>,
}

impl ShellPtySessionManager {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudSyncConfig {
    server_url: String,
    device_id: Uuid,
    access_token: String,
}

struct DesktopCloudSync {
    config: Mutex<Option<CloudSyncConfig>>,
    outbound: Mutex<Option<mpsc::UnboundedSender<RealtimeMessage>>>,
    generation: AtomicU64,
}

impl DesktopCloudSync {
    fn new(config: Option<CloudSyncConfig>) -> Self {
        Self {
            config: Mutex::new(config),
            outbound: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    fn config(&self) -> Option<CloudSyncConfig> {
        self.config.lock().ok().and_then(|config| config.clone())
    }

    fn set_config(&self, config: CloudSyncConfig) {
        if let Ok(mut current) = self.config.lock() {
            *current = Some(config);
        }
    }

    fn set_outbound(&self, tx: Option<mpsc::UnboundedSender<RealtimeMessage>>) {
        if let Ok(mut outbound) = self.outbound.lock() {
            *outbound = tx;
        }
    }

    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current_generation(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn send(&self, message: RealtimeMessage) {
        if let Ok(outbound) = self.outbound.lock() {
            if let Some(tx) = outbound.as_ref() {
                let _ = tx.send(message);
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    code: String,
    name: String,
    os: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDesktopPairingRequest {
    name: String,
    os: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    device_id: Uuid,
    access_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPairingRequestResponse {
    code: String,
    expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPairingStatusResponse {
    status: String,
    expires_at: chrono::DateTime<chrono::Utc>,
    device_id: Option<Uuid>,
    access_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopQrPairingPayload {
    kind: String,
    server_url: String,
    code: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedCloudConfig {
    server_url: String,
    device_id: Uuid,
    paired: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    path: String,
    branch: Option<String>,
    dirty: bool,
    files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAiSessionRequest {
    provider_id: String,
    project_path: String,
    title: String,
    creation_mode: String,
    terminal_session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendAiPromptRequest {
    ai_session_id: Uuid,
    terminal_session_id: String,
    prompt: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureAiReplyRequest {
    terminal_session_id: String,
    prompt: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellInputRequest {
    ai_session_id: Uuid,
    text: String,
    submit: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeShellRequest {
    ai_session_id: Uuid,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartShellPtyRequest {
    ai_session_id: Uuid,
    cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunCodexChatRequest {
    ai_session_id: Uuid,
    project_path: String,
    prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunAiChatRequest {
    ai_session_id: Uuid,
    project_path: String,
    prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellTerminalEvent {
    ai_session_id: Uuid,
    chunk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellSessionStatusEvent {
    ai_session_id: Uuid,
    status: String,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChatOutputEvent {
    ai_session_id: Uuid,
    kind: String,
    text: Option<String>,
    step_id: Option<String>,
    segment: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct CodexSessionIndexEntry {
    id: String,
    thread_name: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct CodexSessionMetaLine {
    #[serde(rename = "type")]
    kind: String,
    payload: CodexSessionMetaPayload,
}

#[derive(Debug, Deserialize)]
struct CodexSessionMetaPayload {
    id: String,
    cwd: Option<String>,
}

#[tauri::command]
async fn list_sessions() -> Result<Vec<TerminalSession>, String> {
    let mut sessions = Vec::new();
    sessions.extend(list_tmux_sessions().await.unwrap_or_default());
    sessions.extend(list_screen_sessions().await.unwrap_or_default());
    Ok(sessions)
}

#[tauri::command]
async fn pair_desktop(
    app: AppHandle,
    cloud: State<'_, Arc<DesktopCloudSync>>,
    server: String,
    code: String,
) -> Result<PairResponse, String> {
    let url = format!("{}/desktop/pair", server.trim_end_matches('/'));
    let name = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "Desktop".to_string());
    let request = PairRequest {
        code,
        name,
        os: std::env::consts::OS.to_string(),
    };
    let response = reqwest::Client::new()
        .post(url)
        .json(&request)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<PairResponse>()
        .await
        .map_err(|error| error.to_string())?;
    let config = CloudSyncConfig {
        server_url: server.trim_end_matches('/').to_string(),
        device_id: response.device_id,
        access_token: response.access_token.clone(),
    };
    save_cloud_config(&config).map_err(|error| error.to_string())?;
    cloud.set_config(config.clone());
    start_cloud_sync(app, cloud.inner().clone(), config);
    Ok(response)
}

fn desktop_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "Desktop".to_string())
}

#[tauri::command]
async fn create_desktop_pairing_request(
    server: String,
) -> Result<DesktopPairingRequestResponse, String> {
    let url = format!("{}/desktop/pairing-requests", server.trim_end_matches('/'));
    let request = CreateDesktopPairingRequest {
        name: desktop_name(),
        os: std::env::consts::OS.to_string(),
    };
    reqwest::Client::new()
        .post(url)
        .json(&request)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<DesktopPairingRequestResponse>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_desktop_pairing_status(
    app: AppHandle,
    cloud: State<'_, Arc<DesktopCloudSync>>,
    server: String,
    code: String,
) -> Result<DesktopPairingStatusResponse, String> {
    let trimmed_server = server.trim_end_matches('/').to_string();
    let url = format!(
        "{}/desktop/pairing-requests/{}",
        trimmed_server,
        code.trim()
    );
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<DesktopPairingStatusResponse>()
        .await
        .map_err(|error| error.to_string())?;
    if response.status == "approved" {
        if let (Some(device_id), Some(access_token)) =
            (response.device_id, response.access_token.clone())
        {
            let config = CloudSyncConfig {
                server_url: trimmed_server,
                device_id,
                access_token,
            };
            save_cloud_config(&config).map_err(|error| error.to_string())?;
            cloud.set_config(config.clone());
            start_cloud_sync(app, cloud.inner().clone(), config);
        }
    }
    Ok(response)
}

#[tauri::command]
fn build_desktop_pairing_qr_payload(server: String, code: String) -> Result<String, String> {
    serde_json::to_string(&DesktopQrPairingPayload {
        kind: "ai-workbench.desktop-pairing".to_string(),
        server_url: server.trim_end_matches('/').to_string(),
        code: code.trim().to_string(),
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_cloud_config() -> Result<Option<SavedCloudConfig>, String> {
    Ok(load_cloud_config()
        .map_err(|error| error.to_string())?
        .map(|config| SavedCloudConfig {
            server_url: config.server_url,
            device_id: config.device_id,
            paired: true,
        }))
}

#[tauri::command]
async fn list_ai_providers() -> Result<Vec<AiProviderDefinition>, String> {
    Ok(default_providers())
}

#[tauri::command]
async fn detect_ai_providers() -> Result<Vec<DesktopProviderStatus>, String> {
    let mut statuses = Vec::new();
    for provider in default_providers() {
        let version = run_output(&provider.command, &["--version"]).await.ok();
        statuses.push(DesktopProviderStatus {
            provider_id: provider.id,
            installed: version.is_some(),
            version,
            auth_status: ProviderAuthStatus::Unknown,
            last_checked_at: chrono::Utc::now(),
        });
    }
    Ok(statuses)
}

#[tauri::command]
async fn add_workspace_project(path: String) -> Result<WorkspaceProject, String> {
    let project = project_from_path(path).await?;
    save_local_project(&project).map_err(|error| error.to_string())?;
    Ok(project)
}

#[tauri::command]
async fn choose_workspace_project() -> Result<Option<WorkspaceProject>, String> {
    let selected = tokio::task::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|error| error.to_string())?;
    match selected {
        Some(path) => {
            let project = project_from_path(path.to_string_lossy().to_string()).await?;
            save_local_project(&project).map_err(|error| error.to_string())?;
            Ok(Some(project))
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn list_workspace_projects() -> Result<Vec<WorkspaceProject>, String> {
    load_local_projects().map_err(|error| error.to_string())
}

#[tauri::command]
async fn rename_workspace_project(id: String, name: String) -> Result<WorkspaceProject, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("项目名称不能为空".to_string());
    }
    let mut project = load_local_projects()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|project| project.id.to_string() == id)
        .ok_or_else(|| "项目不存在".to_string())?;
    project.name = trimmed.to_string();
    project.updated_at = chrono::Utc::now();
    save_local_project(&project).map_err(|error| error.to_string())?;
    Ok(project)
}

#[tauri::command]
async fn remove_workspace_project(id: String) -> Result<(), String> {
    ensure_local_db().map_err(|error| error.to_string())?;
    let conn = open_local_db().map_err(|error| error.to_string())?;
    let deleted = conn
        .execute("DELETE FROM local_projects WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Err("项目不存在".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn open_project_in_file_manager(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("项目路径为空".to_string());
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("无法访问项目路径：{error}"))?;
    if !metadata.is_dir() {
        return Err("项目路径不是一个目录".to_string());
    }
    let (program, args) = if cfg!(target_os = "macos") {
        ("open", vec![path.clone()])
    } else if cfg!(target_os = "windows") {
        ("explorer", vec![path.clone()])
    } else {
        ("xdg-open", vec![path.clone()])
    };
    let status = tokio::process::Command::new(program)
        .args(&args)
        .status()
        .await
        .map_err(|error| format!("无法启动文件管理器：{error}"))?;
    if !status.success() {
        return Err(format!("文件管理器退出异常：{status}"));
    }
    Ok(())
}

async fn project_from_path(path: String) -> Result<WorkspaceProject, String> {
    let git = git_status(path.clone()).await.unwrap_or(GitStatus {
        path: path.clone(),
        branch: None,
        dirty: false,
        files: Vec::new(),
    });
    let name = PathBuf::from(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("项目")
        .to_string();
    Ok(WorkspaceProject {
        id: Uuid::new_v4(),
        device_id: Uuid::nil(),
        name,
        path,
        git_branch: git.branch,
        git_dirty: git.dirty,
        updated_at: chrono::Utc::now(),
    })
}

#[tauri::command]
async fn get_git_status(path: String) -> Result<GitStatus, String> {
    git_status(path).await
}

#[tauri::command]
async fn create_ai_session(req: CreateAiSessionRequest) -> Result<AiSession, String> {
    create_ai_session_with_id(Uuid::new_v4(), req).await
}

async fn create_ai_session_with_id(
    session_id: Uuid,
    req: CreateAiSessionRequest,
) -> Result<AiSession, String> {
    create_ai_session_with_id_inner(session_id, req, false).await
}

async fn create_ai_session_with_id_inner(
    session_id: Uuid,
    req: CreateAiSessionRequest,
    ensure_project: bool,
) -> Result<AiSession, String> {
    ensure_local_db().map_err(|error| error.to_string())?;
    let _provider = default_providers()
        .into_iter()
        .find(|item| item.id == req.provider_id)
        .ok_or_else(|| "unknown provider".to_string())?;
    if ensure_project && !req.project_path.trim().is_empty() {
        let known_project = load_local_projects()
            .map_err(|error| error.to_string())?
            .into_iter()
            .any(|project| project.path == req.project_path);
        if !known_project {
            let project = project_from_path(req.project_path.clone()).await?;
            save_local_project(&project).map_err(|error| error.to_string())?;
        }
    }
    let session = AiSession {
        id: session_id,
        user_id: Uuid::nil(),
        device_id: Uuid::nil(),
        project_id: None,
        provider_id: req.provider_id,
        terminal_session_id: None,
        provider_session_id: None,
        title: req.title,
        status: AiSessionStatus::Running,
        summary: Some(req.project_path.clone()),
        archived_at: None,
        updated_at: chrono::Utc::now(),
    };
    save_local_session(&session).map_err(|error| error.to_string())?;
    Ok(session)
}

#[tauri::command]
async fn restart_ai_session(ai_session_id: Uuid) -> Result<AiSession, String> {
    ensure_local_db().map_err(|error| error.to_string())?;
    let mut session = load_local_sessions()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == ai_session_id)
        .ok_or_else(|| "ai session not found".to_string())?;
    if session.provider_session_id.is_none() {
        session.provider_session_id = infer_provider_session_id(&session);
    }
    session.status = AiSessionStatus::Running;
    session.updated_at = chrono::Utc::now();
    save_local_session(&session).map_err(|error| error.to_string())?;
    Ok(session)
}

#[tauri::command]
async fn append_local_ai_message(
    ai_session_id: Uuid,
    role: String,
    content: String,
) -> Result<(), String> {
    let role = match role.as_str() {
        "user" => AiMessageRole::User,
        "assistant" => AiMessageRole::Assistant,
        "system" => AiMessageRole::System,
        "error" => AiMessageRole::Error,
        _ => return Err("invalid role".to_string()),
    };
    save_local_message(ai_session_id, role, &content).map_err(|error| error.to_string())
}

#[tauri::command]
async fn send_ai_prompt(req: SendAiPromptRequest) -> Result<String, String> {
    if req.prompt.trim().is_empty() {
        return Err("prompt cannot be empty".to_string());
    }
    let before_output = capture_recent_output(&req.terminal_session_id, 160)
        .await
        .unwrap_or_default();
    save_local_message(req.ai_session_id, AiMessageRole::User, &req.prompt)
        .map_err(|error| error.to_string())?;
    send_text_to_terminal(&req.terminal_session_id, &req.prompt, true).await?;
    let output = wait_for_ai_output(&req.terminal_session_id, &before_output, &req.prompt).await?;
    if !output.trim().is_empty() {
        save_local_message(req.ai_session_id, AiMessageRole::Assistant, &output)
            .map_err(|error| error.to_string())?;
    }
    Ok(output)
}

#[tauri::command]
async fn capture_ai_reply(req: CaptureAiReplyRequest) -> Result<String, String> {
    let output = capture_recent_output(&req.terminal_session_id, 260).await?;
    Ok(extract_reply_from_current_screen(&output, &req.prompt))
}

#[tauri::command]
async fn start_shell_pty(
    app: AppHandle,
    manager: State<'_, ShellPtySessionManager>,
    req: StartShellPtyRequest,
) -> Result<(), String> {
    start_shell_pty_for_session(&app, &manager, req.ai_session_id, &req.cwd)
}

#[tauri::command]
async fn send_shell_input(
    manager: State<'_, ShellPtySessionManager>,
    req: ShellInputRequest,
) -> Result<(), String> {
    if req.text.is_empty() && !req.submit {
        return Ok(());
    }
    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "shell session manager lock poisoned".to_string())?;
    let session = sessions
        .get_mut(&req.ai_session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    session
        .writer
        .write_all(req.text.as_bytes())
        .map_err(|error| error.to_string())?;
    if req.submit {
        session
            .writer
            .write_all(b"\r\n")
            .map_err(|error| error.to_string())?;
    }
    session.writer.flush().map_err(|error| error.to_string())
}

#[tauri::command]
async fn resize_shell(
    manager: State<'_, ShellPtySessionManager>,
    req: ResizeShellRequest,
) -> Result<(), String> {
    let sessions = manager
        .sessions
        .lock()
        .map_err(|_| "shell session manager lock poisoned".to_string())?;
    let session = sessions
        .get(&req.ai_session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: req.rows.max(1),
            cols: req.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_shell_buffer(
    manager: State<'_, ShellPtySessionManager>,
    ai_session_id: Uuid,
) -> Result<String, String> {
    let sessions = manager
        .sessions
        .lock()
        .map_err(|_| "shell session manager lock poisoned".to_string())?;
    let session = sessions
        .get(&ai_session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    session
        .output
        .lock()
        .map(|output| output.clone())
        .map_err(|_| "pty output buffer lock poisoned".to_string())
}

#[tauri::command]
async fn run_codex_chat(app: AppHandle, req: RunCodexChatRequest) -> Result<String, String> {
    let ai_session_id = req.ai_session_id;
    match run_codex_chat_app_server(app.clone(), req).await {
        Ok(reply) => Ok(reply),
        Err(error) => {
            emit_ai_chat_error_for_provider(&app, ai_session_id, "codex", &error);
            Err(error)
        }
    }
}

#[tauri::command]
async fn run_ai_chat(app: AppHandle, req: RunAiChatRequest) -> Result<String, String> {
    let ai_session_id = req.ai_session_id;
    let provider_id = load_local_sessions()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == ai_session_id)
        .map(|session| session.provider_id)
        .ok_or_else(|| "ai session not found".to_string())?;
    let result = match provider_id.as_str() {
        "codex" => {
            run_codex_chat_app_server(
                app.clone(),
                RunCodexChatRequest {
                    ai_session_id: req.ai_session_id,
                    project_path: req.project_path,
                    prompt: req.prompt,
                },
            )
            .await
        }
        "claude" => run_claude_chat_stream_json(app.clone(), req).await,
        _ => Err(format!(
            "{} 暂不支持结构化聊天。可以在终端页直接运行对应 CLI。",
            provider_display_name(&provider_id)
        )),
    };
    match result {
        Ok(reply) => Ok(reply),
        Err(error) => {
            emit_ai_chat_error_for_provider(&app, ai_session_id, &provider_id, &error);
            Err(error)
        }
    }
}

async fn run_codex_chat_app_server(
    app: AppHandle,
    req: RunCodexChatRequest,
) -> Result<String, String> {
    let started_at = Instant::now();
    let user_prompt = req.prompt.trim().to_string();
    if user_prompt.is_empty() {
        return Err("prompt cannot be empty".to_string());
    }
    let session = load_local_sessions()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == req.ai_session_id)
        .ok_or_else(|| "ai session not found".to_string())?;
    if session.provider_id != "codex" {
        return Err("run_codex_chat only supports Codex sessions".to_string());
    }
    let existing_thread_id = session
        .provider_session_id
        .as_deref()
        .and_then(codex_app_server_thread_id)
        .map(str::to_string);

    let prompt = user_prompt.clone();
    emit_ai_chat_status(&app, req.ai_session_id, "正在连接 Codex app-server...");

    let mut child = Command::new("codex")
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start codex app-server: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to capture codex app-server stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture codex app-server stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture codex app-server stderr".to_string())?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut lines = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if !line.trim().is_empty() {
                lines.push(line);
            }
        }
        lines.join("\n")
    });

    let mut next_id = 1_u64;
    write_jsonrpc_message(
        &mut stdin,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": next_id,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "ai-workbench-desktop",
                    "title": "AI 工作台",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": true,
                },
            },
        }),
    )
    .await?;
    let initialize_id = next_id;
    next_id += 1;

    let mut reader = BufReader::new(stdout).lines();
    let mut initialized = false;
    let mut thread_id: Option<String> = existing_thread_id;
    let mut pending_resume_id: Option<u64> = None;
    let mut turn_started = false;
    let mut final_text = String::new();
    let mut command_outputs: HashMap<String, String> = HashMap::new();

    loop {
        let line = match tokio::time::timeout(Duration::from_secs(60), reader.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) => return Err("Codex app-server 60 秒内没有返回新事件。".to_string()),
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        eprintln!(
            "[run_codex_app_server +{}ms] stdout: {trimmed}",
            started_at.elapsed().as_millis()
        );
        let value: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|error| format!("invalid codex app-server JSON-RPC: {error}: {trimmed}"))?;
        if let Some(error) = value.get("error") {
            if value.get("id").and_then(|value| value.as_u64()) == pending_resume_id {
                pending_resume_id = None;
                thread_id = None;
                emit_ai_chat_status(
                    &app,
                    req.ai_session_id,
                    "Codex 历史会话未找到，正在创建新的 app-server 会话...",
                );
                write_jsonrpc_message(
                    &mut stdin,
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": next_id,
                        "method": "thread/start",
                        "params": {
                            "cwd": req.project_path,
                            "runtimeWorkspaceRoots": [req.project_path],
                            "approvalPolicy": "never",
                            "sandbox": "danger-full-access",
                            "developerInstructions": codex_desktop_developer_instructions(),
                        },
                    }),
                )
                .await?;
                next_id += 1;
                continue;
            }
            return Err(codex_jsonrpc_error_message(error));
        }

        if value.get("id").and_then(|value| value.as_u64()) == Some(initialize_id)
            && value.get("result").is_some()
            && !initialized
        {
            initialized = true;
            write_jsonrpc_message(
                &mut stdin,
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "initialized",
                }),
            )
            .await?;

            if thread_id.is_none() {
                emit_ai_chat_status(&app, req.ai_session_id, "正在创建 Codex app-server 会话...");
                write_jsonrpc_message(
                    &mut stdin,
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": next_id,
                        "method": "thread/start",
                        "params": {
                            "cwd": req.project_path,
                            "runtimeWorkspaceRoots": [req.project_path],
                            "approvalPolicy": "never",
                            "sandbox": "danger-full-access",
                            "developerInstructions": codex_desktop_developer_instructions(),
                        },
                    }),
                )
                .await?;
                next_id += 1;
            } else {
                let existing_thread_id = thread_id.as_deref().unwrap();
                emit_ai_chat_status(&app, req.ai_session_id, "正在恢复 Codex app-server 会话...");
                write_jsonrpc_message(
                    &mut stdin,
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": next_id,
                        "method": "thread/resume",
                        "params": {
                            "threadId": existing_thread_id,
                            "cwd": req.project_path,
                            "approvalPolicy": "never",
                            "sandbox": "danger-full-access",
                            "developerInstructions": codex_desktop_developer_instructions(),
                        },
                    }),
                )
                .await?;
                pending_resume_id = Some(next_id);
                next_id += 1;
            }
            continue;
        }

        if value.get("id").and_then(|value| value.as_u64()) == pending_resume_id
            && value.get("result").is_some()
        {
            pending_resume_id = None;
            if let Some(id) = value.get("result").and_then(extract_codex_thread_id) {
                thread_id = Some(id.to_string());
                set_local_session_provider_session_id(
                    req.ai_session_id,
                    &format!("app-server:{id}"),
                )
                .map_err(|error| error.to_string())?;
            }
            let Some(id) = thread_id.as_deref() else {
                return Err("Codex app-server 恢复会话后没有返回 thread id。".to_string());
            };
            emit_ai_chat_status(&app, req.ai_session_id, "Codex app-server 会话已恢复");
            start_codex_app_server_turn(&mut stdin, &mut next_id, id, &req.project_path, &prompt)
                .await?;
            turn_started = true;
            emit_ai_chat_status(&app, req.ai_session_id, "Codex app-server 正在处理...");
            continue;
        }

        if let Some(method) = value.get("method").and_then(|value| value.as_str()) {
            match method {
                "thread/started" => {
                    if let Some(id) = value
                        .get("params")
                        .and_then(|params| extract_codex_thread_id(params))
                    {
                        thread_id = Some(id.to_string());
                        set_local_session_provider_session_id(
                            req.ai_session_id,
                            &format!("app-server:{id}"),
                        )
                        .map_err(|error| error.to_string())?;
                        emit_ai_chat_status(&app, req.ai_session_id, "Codex app-server 会话已连接");
                        start_codex_app_server_turn(
                            &mut stdin,
                            &mut next_id,
                            id,
                            &req.project_path,
                            &prompt,
                        )
                        .await?;
                        turn_started = true;
                        emit_ai_chat_status(
                            &app,
                            req.ai_session_id,
                            "Codex app-server 正在处理...",
                        );
                    }
                }
                "turn/started" => {
                    emit_ai_chat_status(&app, req.ai_session_id, "Codex 正在生成回复...");
                }
                "item/started" => {
                    if let Some(item) = value.get("params").and_then(|params| params.get("item")) {
                        if let Some((step_id, segment)) = codex_item_segment(item, "running") {
                            emit_ai_chat_step(
                                &app,
                                req.ai_session_id,
                                "step-start",
                                &step_id,
                                segment,
                            );
                        }
                    }
                }
                "item/agentMessage/delta" => {
                    if let Some(delta) = value
                        .get("params")
                        .and_then(|params| params.get("delta"))
                        .and_then(|delta| delta.as_str())
                    {
                        final_text.push_str(delta);
                        emit_ai_chat_delta(&app, req.ai_session_id, delta, &final_text);
                    }
                }
                "item/commandExecution/outputDelta" => {
                    let params = value.get("params").unwrap_or(&serde_json::Value::Null);
                    let item_id = params
                        .get("itemId")
                        .and_then(|value| value.as_str())
                        .unwrap_or("command-output")
                        .to_string();
                    let delta = params
                        .get("delta")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let output = command_outputs.entry(item_id.clone()).or_default();
                    output.push_str(delta);
                    emit_ai_chat_step(
                        &app,
                        req.ai_session_id,
                        "step-update",
                        &item_id,
                        serde_json::json!({
                            "type": "tool",
                            "stepId": item_id,
                            "toolName": "运行命令",
                            "status": "running",
                            "summary": "命令正在输出",
                            "output": output,
                        }),
                    );
                }
                "item/completed" => {
                    if let Some(item) = value.get("params").and_then(|params| params.get("item")) {
                        if let Some((step_id, mut segment)) =
                            codex_item_segment(item, codex_completed_status(item))
                        {
                            if let Some(output) = command_outputs.get(&step_id) {
                                if let Some(object) = segment.as_object_mut() {
                                    object.insert(
                                        "output".to_string(),
                                        serde_json::Value::String(output.clone()),
                                    );
                                }
                            }
                            emit_ai_chat_step(
                                &app,
                                req.ai_session_id,
                                "step-update",
                                &step_id,
                                segment,
                            );
                        }
                    }
                }
                "turn/completed" => {
                    let _ = child.kill().await;
                    let _ = tokio::time::timeout(Duration::from_millis(250), child.wait()).await;
                    if final_text.trim().is_empty() {
                        return Err("Codex app-server 没有返回可显示的回复。".to_string());
                    }
                    save_local_message(req.ai_session_id, AiMessageRole::Assistant, &final_text)
                        .map_err(|error| error.to_string())?;
                    emit_ai_chat_done(&app, req.ai_session_id, &final_text);
                    return Ok(final_text);
                }
                "error" => {
                    let message = value
                        .get("params")
                        .and_then(codex_app_server_error_notification_message)
                        .unwrap_or_else(|| "Codex app-server error".to_string());
                    if final_text.trim().is_empty() {
                        return Err(message);
                    }
                    emit_ai_chat_status(
                        &app,
                        req.ai_session_id,
                        &format!("Codex app-server 后续事件报错，已保留当前回复：{message}"),
                    );
                    save_local_message(req.ai_session_id, AiMessageRole::Assistant, &final_text)
                        .map_err(|error| error.to_string())?;
                    emit_ai_chat_done(&app, req.ai_session_id, &final_text);
                    return Ok(final_text);
                }
                _ => {}
            }
        }

        if let Some(id) = value.get("id").cloned() {
            if value.get("method").is_some()
                && value.get("result").is_none()
                && value.get("error").is_none()
            {
                write_jsonrpc_message(
                    &mut stdin,
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "decision": "denied",
                            "reason": "AI 工作台暂未接入 app-server 审批弹窗。请改用不需要审批的操作。",
                        },
                    }),
                )
                .await?;
            }
        }
    }

    let stderr_output = stderr_task.await.unwrap_or_default();
    if !turn_started {
        Err(if stderr_output.trim().is_empty() {
            "Codex app-server exited before starting a turn".to_string()
        } else {
            stderr_output
        })
    } else {
        Err(if stderr_output.trim().is_empty() {
            "Codex app-server exited before completing the turn".to_string()
        } else {
            stderr_output
        })
    }
}

async fn start_codex_app_server_turn(
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    thread_id: &str,
    project_path: &str,
    prompt: &str,
) -> Result<(), String> {
    write_jsonrpc_message(
        stdin,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": *next_id,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "cwd": project_path,
                "runtimeWorkspaceRoots": [project_path],
                "approvalPolicy": "never",
                "sandboxPolicy": {
                    "type": "dangerFullAccess",
                },
                "input": [{
                    "type": "text",
                    "text": prompt,
                    "text_elements": [],
                }],
            },
        }),
    )
    .await?;
    *next_id += 1;
    Ok(())
}

async fn write_jsonrpc_message(
    stdin: &mut tokio::process::ChildStdin,
    message: serde_json::Value,
) -> Result<(), String> {
    let payload = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|error| error.to_string())?;
    stdin.flush().await.map_err(|error| error.to_string())
}

fn extract_codex_thread_id(params: &serde_json::Value) -> Option<&str> {
    params
        .get("thread")
        .and_then(|thread| thread.get("id").or_else(|| thread.get("threadId")))
        .and_then(|value| value.as_str())
        .or_else(|| params.get("threadId").and_then(|value| value.as_str()))
        .or_else(|| params.get("id").and_then(|value| value.as_str()))
}

fn codex_jsonrpc_error_message(error: &serde_json::Value) -> String {
    let message = error
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or("Codex app-server JSON-RPC error");
    let code = error.get("code").and_then(|value| value.as_i64());
    match code {
        Some(code) => format!("Codex app-server error {code}: {message}"),
        None => message.to_string(),
    }
}

fn codex_app_server_error_notification_message(params: &serde_json::Value) -> Option<String> {
    let error = params.get("error").unwrap_or(params);
    let message = error
        .get("message")
        .and_then(|value| value.as_str())
        .or_else(|| params.get("message").and_then(|value| value.as_str()))?;
    let details = error
        .get("additionalDetails")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let info = error
        .get("codexErrorInfo")
        .filter(|value| !value.is_null())
        .map(|value| value.to_string());
    let retry = params
        .get("willRetry")
        .and_then(|value| value.as_bool())
        .map(|value| {
            if value {
                "will retry"
            } else {
                "will not retry"
            }
        });
    let mut parts = vec![message.to_string()];
    if let Some(details) = details {
        parts.push(details.to_string());
    }
    if let Some(info) = info {
        parts.push(format!("info={info}"));
    }
    if let Some(retry) = retry {
        parts.push(retry.to_string());
    }
    Some(parts.join("；"))
}

fn codex_app_server_thread_id(provider_session_id: &str) -> Option<&str> {
    provider_session_id
        .strip_prefix("app-server:")
        .filter(|thread_id| !thread_id.trim().is_empty())
}

async fn run_claude_chat_stream_json(
    app: AppHandle,
    req: RunAiChatRequest,
) -> Result<String, String> {
    let user_prompt = req.prompt.trim().to_string();
    if user_prompt.is_empty() {
        return Err("prompt cannot be empty".to_string());
    }
    let session = load_local_sessions()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == req.ai_session_id)
        .ok_or_else(|| "ai session not found".to_string())?;
    if session.provider_id != "claude" {
        return Err("run_claude_chat only supports Claude Code sessions".to_string());
    }
    let prompt = claude_desktop_prompt(&user_prompt);
    if let Some(existing_session_id) = session
        .provider_session_id
        .as_deref()
        .and_then(claude_provider_session_id)
        .map(str::to_string)
    {
        match run_claude_chat_once(
            app.clone(),
            req.clone(),
            prompt.clone(),
            existing_session_id,
            true,
        )
        .await
        {
            Ok(reply) => return Ok(reply),
            Err(error) => {
                emit_ai_chat_status(
                    &app,
                    req.ai_session_id,
                    "Claude 历史会话未找到，已创建新会话。",
                );
                eprintln!("[run_claude_stream_json] resume failed, starting fresh: {error}");
            }
        }
    }

    let session_id = req.ai_session_id.to_string();
    set_local_session_provider_session_id(req.ai_session_id, &format!("claude:{session_id}"))
        .map_err(|error| error.to_string())?;
    run_claude_chat_once(app, req, prompt, session_id, false).await
}

async fn run_claude_chat_once(
    app: AppHandle,
    req: RunAiChatRequest,
    prompt: String,
    claude_session_id: String,
    resume: bool,
) -> Result<String, String> {
    let started_at = Instant::now();
    emit_ai_chat_status(
        &app,
        req.ai_session_id,
        if resume {
            "正在恢复 Claude Code 会话..."
        } else {
            "正在启动 Claude Code..."
        },
    );

    let mut command = Command::new("claude");
    command
        .current_dir(&req.project_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args([
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-mode",
            "plan",
            "--append-system-prompt",
            "你正在 AI 工作台桌面端中运行。回复使用中文，直接、简洁；如果用户要求查看、检查或分析项目，必须实际读取本机项目文件后再给结论。",
        ]);
    if resume {
        command.arg("--resume").arg(&claude_session_id);
    } else {
        command.arg("--session-id").arg(&claude_session_id);
    }
    command.arg(prompt);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start Claude Code: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture Claude Code stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture Claude Code stderr".to_string())?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut lines = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if !line.trim().is_empty() {
                lines.push(line);
            }
        }
        lines.join("\n")
    });

    let mut reader = BufReader::new(stdout).lines();
    let mut final_text = String::new();
    let mut saw_event = false;
    loop {
        let line = match tokio::time::timeout(Duration::from_secs(120), reader.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) => return Err("Claude Code 120 秒内没有返回新事件。".to_string()),
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        saw_event = true;
        eprintln!(
            "[run_claude_stream_json +{}ms] stdout: {trimmed}",
            started_at.elapsed().as_millis()
        );
        if handle_claude_stream_json_line(&app, req.ai_session_id, trimmed, &mut final_text)? {
            break;
        }
    }

    let status = child.wait().await.map_err(|error| error.to_string())?;
    let stderr_output = stderr_task.await.unwrap_or_default();
    if !status.success() && final_text.trim().is_empty() {
        return Err(if stderr_output.trim().is_empty() {
            "Claude Code 执行失败。".to_string()
        } else {
            stderr_output
        });
    }
    if !saw_event && final_text.trim().is_empty() {
        return Err("Claude Code 没有返回 stream-json 事件。".to_string());
    }
    if final_text.trim().is_empty() {
        return Err("Claude Code 没有返回可显示的回复。".to_string());
    }
    save_local_message(req.ai_session_id, AiMessageRole::Assistant, &final_text)
        .map_err(|error| error.to_string())?;
    emit_ai_chat_done(&app, req.ai_session_id, &final_text);
    Ok(final_text)
}

fn handle_claude_stream_json_line(
    app: &AppHandle,
    ai_session_id: Uuid,
    line: &str,
    final_text: &mut String,
) -> Result<bool, String> {
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|error| format!("invalid Claude Code stream JSON: {error}: {line}"))?;
    let event_type = value
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    match event_type {
        "system" => {
            if value.get("subtype").and_then(|value| value.as_str()) == Some("init") {
                emit_ai_chat_status(app, ai_session_id, "Claude Code 会话已连接");
            }
        }
        "assistant" => {
            if let Some(message) = value.get("message") {
                emit_claude_tool_segments(app, ai_session_id, message);
                if let Some(text) = claude_message_text(message) {
                    append_claude_text(app, ai_session_id, final_text, &text);
                }
            }
        }
        "stream_event" => {
            if let Some(event) = value.get("event") {
                handle_claude_nested_stream_event(app, ai_session_id, event, final_text);
            }
        }
        "result" => {
            if value
                .get("is_error")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                let message = value
                    .get("result")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("Claude Code 执行失败。");
                if final_text.trim().is_empty() {
                    return Err(message.to_string());
                }
                emit_ai_chat_status(
                    app,
                    ai_session_id,
                    &format!("Claude Code 后续事件报错，已保留当前回复：{message}"),
                );
                return Ok(true);
            }
            if let Some(text) = value
                .get("result")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                append_claude_text(app, ai_session_id, final_text, text);
            }
            return Ok(true);
        }
        other if other.contains("delta") => {
            if let Some(text) = value
                .pointer("/delta/text")
                .and_then(|value| value.as_str())
                .or_else(|| value.get("text").and_then(|value| value.as_str()))
            {
                append_claude_text(app, ai_session_id, final_text, text);
            }
        }
        _ => {}
    }
    Ok(false)
}

fn handle_claude_nested_stream_event(
    app: &AppHandle,
    ai_session_id: Uuid,
    event: &serde_json::Value,
    final_text: &mut String,
) {
    match event
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("")
    {
        "content_block_start" => {
            if event
                .get("content_block")
                .and_then(|block| block.get("type"))
                .and_then(|value| value.as_str())
                == Some("tool_use")
            {
                let block = event
                    .get("content_block")
                    .unwrap_or(&serde_json::Value::Null);
                let id = block
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("claude-tool");
                let name = block
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Claude 工具");
                emit_ai_chat_step(
                    app,
                    ai_session_id,
                    "step-start",
                    id,
                    serde_json::json!({
                        "type": "tool",
                        "stepId": id,
                        "toolName": name,
                        "status": "running",
                        "summary": "Claude Code 正在使用工具",
                    }),
                );
            }
        }
        "content_block_delta" => {
            if let Some(text) = event
                .pointer("/delta/text")
                .and_then(|value| value.as_str())
                .filter(|_| {
                    event
                        .pointer("/delta/type")
                        .and_then(|value| value.as_str())
                        == Some("text_delta")
                })
            {
                append_claude_text(app, ai_session_id, final_text, text);
            }
        }
        _ => {}
    }
}

fn append_claude_text(app: &AppHandle, ai_session_id: Uuid, final_text: &mut String, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    let delta = if text.starts_with(final_text.as_str()) {
        text[final_text.len()..].to_string()
    } else if final_text.ends_with(text) {
        String::new()
    } else {
        text.to_string()
    };
    if delta.is_empty() {
        return;
    }
    final_text.push_str(&delta);
    emit_ai_chat_delta(app, ai_session_id, &delta, final_text);
}

fn claude_message_text(message: &serde_json::Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let mut parts = Vec::new();
    if let Some(items) = content.as_array() {
        for item in items {
            if item.get("type").and_then(|value| value.as_str()) == Some("text") {
                if let Some(text) = item.get("text").and_then(|value| value.as_str()) {
                    parts.push(text);
                }
            }
        }
    }
    (!parts.is_empty()).then(|| parts.join(""))
}

fn emit_claude_tool_segments(app: &AppHandle, ai_session_id: Uuid, message: &serde_json::Value) {
    let Some(items) = message.get("content").and_then(|value| value.as_array()) else {
        return;
    };
    for item in items {
        let item_type = item
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if item_type != "tool_use" {
            continue;
        }
        let id = item
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("claude-tool");
        let name = item
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("Claude 工具");
        emit_ai_chat_step(
            app,
            ai_session_id,
            "step-start",
            id,
            serde_json::json!({
                "type": "tool",
                "stepId": id,
                "toolName": name,
                "status": "running",
                "summary": "Claude Code 正在使用工具",
                "input": item.get("input").map(|value| value.to_string()).unwrap_or_default(),
            }),
        );
    }
}

fn claude_provider_session_id(provider_session_id: &str) -> Option<&str> {
    provider_session_id
        .strip_prefix("claude:")
        .filter(|session_id| !session_id.trim().is_empty())
}

#[tauri::command]
async fn warmup_codex_session(app: AppHandle, ai_session_id: Uuid) -> Result<AiSession, String> {
    warmup_ai_session(app, ai_session_id).await
}

#[tauri::command]
async fn warmup_ai_session(app: AppHandle, ai_session_id: Uuid) -> Result<AiSession, String> {
    let session = load_local_sessions()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == ai_session_id)
        .ok_or_else(|| "ai session not found".to_string())?;
    match session.provider_id.as_str() {
        "codex" => emit_ai_chat_status(&app, ai_session_id, "Codex app-server 将在发送消息时连接"),
        "claude" => emit_ai_chat_status(&app, ai_session_id, "Claude Code 将在发送消息时连接"),
        _ => {}
    }
    Ok(session)
}

#[tauri::command]
async fn stop_shell_pty(
    manager: State<'_, ShellPtySessionManager>,
    ai_session_id: Uuid,
) -> Result<(), String> {
    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "shell session manager lock poisoned".to_string())?;
    if let Some(mut session) = sessions.remove(&ai_session_id) {
        session.child.kill().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn is_shell_live(
    manager: State<'_, ShellPtySessionManager>,
    ai_session_id: Uuid,
) -> Result<bool, String> {
    let sessions = manager
        .sessions
        .lock()
        .map_err(|_| "shell session manager lock poisoned".to_string())?;
    Ok(sessions.contains_key(&ai_session_id))
}

#[tauri::command]
async fn list_local_ai_history(ai_session_id: Uuid) -> Result<Vec<AiHistoryMessage>, String> {
    load_local_history(ai_session_id).map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_local_ai_sessions() -> Result<Vec<AiSession>, String> {
    load_local_sessions().map_err(|error| error.to_string())
}

#[tauri::command]
async fn archive_local_ai_session(
    ai_session_id: Uuid,
    archived: bool,
) -> Result<AiSession, String> {
    set_local_session_archived(ai_session_id, archived).map_err(|error| error.to_string())
}

#[tauri::command]
async fn rename_local_ai_session(ai_session_id: Uuid, title: String) -> Result<AiSession, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("会话名称不能为空".to_string());
    }
    ensure_local_db().map_err(|error| error.to_string())?;
    let conn = open_local_db().map_err(|error| error.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let updated = conn
        .execute(
            "UPDATE local_ai_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![trimmed, now, ai_session_id.to_string()],
        )
        .map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("会话不存在".to_string());
    }
    load_local_sessions()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|session| session.id == ai_session_id)
        .ok_or_else(|| "会话不存在".to_string())
}

#[tauri::command]
async fn open_session_in_new_window(
    app: AppHandle,
    ai_session_id: Uuid,
) -> Result<(), String> {
    use tauri::WebviewUrl;
    let url = format!("index.html#/session/{}", ai_session_id);
    let label = format!("session-{}", ai_session_id.simple());
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("AI 会话")
        .inner_size(1024.0, 720.0)
        .min_inner_size(640.0, 480.0)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            pair_desktop,
            create_desktop_pairing_request,
            get_desktop_pairing_status,
            build_desktop_pairing_qr_payload,
            get_cloud_config,
            list_ai_providers,
            detect_ai_providers,
            add_workspace_project,
            choose_workspace_project,
            list_workspace_projects,
            rename_workspace_project,
            remove_workspace_project,
            open_project_in_file_manager,
            get_git_status,
            create_ai_session,
            restart_ai_session,
            append_local_ai_message,
            send_ai_prompt,
            capture_ai_reply,
            start_shell_pty,
            send_shell_input,
            resize_shell,
            get_shell_buffer,
            run_ai_chat,
            run_codex_chat,
            warmup_ai_session,
            warmup_codex_session,
            stop_shell_pty,
            is_shell_live,
            list_local_ai_history,
            list_local_ai_sessions,
            archive_local_ai_session,
            rename_local_ai_session,
            open_session_in_new_window
        ])
        .setup(|app| {
            app.manage(ShellPtySessionManager::new());
            let config = load_cloud_config().ok().flatten();
            let cloud = Arc::new(DesktopCloudSync::new(config.clone()));
            app.manage(cloud.clone());
            if let Some(config) = config {
                start_cloud_sync(app.handle().clone(), cloud, config);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn start_cloud_sync(app: AppHandle, cloud: Arc<DesktopCloudSync>, config: CloudSyncConfig) {
    let generation = cloud.next_generation();
    tauri::async_runtime::spawn(async move {
        while cloud.is_current_generation(generation) {
            if let Err(error) =
                connect_cloud_once(app.clone(), cloud.clone(), config.clone(), generation).await
            {
                eprintln!("[cloud-sync] disconnected: {error}");
            }
            if cloud.is_current_generation(generation) {
                cloud.set_outbound(None);
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

async fn connect_cloud_once(
    app: AppHandle,
    cloud: Arc<DesktopCloudSync>,
    config: CloudSyncConfig,
    generation: u64,
) -> Result<(), String> {
    let ws_url = websocket_url(&config.server_url, &config.access_token, "/ws/desktop")?;
    let (stream, _) = connect_async(ws_url)
        .await
        .map_err(|error| error.to_string())?;
    let (mut writer, mut reader) = stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<RealtimeMessage>();
    cloud.set_outbound(Some(tx.clone()));
    send_cloud_bootstrap(&tx, config.device_id).await;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    let mut snapshot = tokio::time::interval(Duration::from_secs(10));

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if !cloud.is_current_generation(generation) {
                    break;
                }
                let _ = tx.send(RealtimeMessage::DesktopHeartbeat {
                    device_id: config.device_id,
                    timestamp: chrono::Utc::now(),
                });
            }
            _ = snapshot.tick() => {
                if !cloud.is_current_generation(generation) {
                    break;
                }
                send_cloud_snapshots(&tx, config.device_id).await;
            }
            outgoing = rx.recv() => {
                let Some(message) = outgoing else { break; };
                let payload = serde_json::to_string(&message).map_err(|error| error.to_string())?;
                writer.send(Message::Text(payload.into())).await.map_err(|error| error.to_string())?;
            }
            incoming = reader.next() => {
                let Some(message) = incoming else { break; };
                let message = message.map_err(|error| error.to_string())?;
                if let Message::Text(text) = message {
                    if let Ok(message) = serde_json::from_str::<RealtimeMessage>(&text) {
                        handle_cloud_message(&app, &tx, config.device_id, message).await;
                    }
                }
            }
        }
    }
    Ok(())
}

async fn send_cloud_bootstrap(tx: &mpsc::UnboundedSender<RealtimeMessage>, device_id: Uuid) {
    let _ = tx.send(RealtimeMessage::DesktopHeartbeat {
        device_id,
        timestamp: chrono::Utc::now(),
    });
    send_cloud_snapshots(tx, device_id).await;
}

async fn send_cloud_snapshots(tx: &mpsc::UnboundedSender<RealtimeMessage>, device_id: Uuid) {
    let providers = detect_ai_providers().await.unwrap_or_default();
    let projects = load_local_projects()
        .unwrap_or_default()
        .into_iter()
        .map(|project| WorkspaceProject {
            device_id,
            ..project
        })
        .collect::<Vec<_>>();
    let sessions = load_local_sessions()
        .unwrap_or_default()
        .into_iter()
        .map(|session| AiSession {
            device_id,
            ..session
        })
        .collect::<Vec<_>>();
    let _ = tx.send(RealtimeMessage::ProvidersSnapshot {
        device_id,
        providers,
    });
    let _ = tx.send(RealtimeMessage::ProjectsSnapshot {
        device_id,
        projects,
    });
    let _ = tx.send(RealtimeMessage::AiSessionsSnapshot {
        device_id,
        sessions,
    });
}

async fn handle_cloud_message(
    app: &AppHandle,
    tx: &mpsc::UnboundedSender<RealtimeMessage>,
    device_id: Uuid,
    message: RealtimeMessage,
) {
    match message {
        RealtimeMessage::AiSessionCreate {
            ai_session_id,
            provider_id,
            project_path,
            title,
            creation_mode,
            terminal_session_id,
            ..
        } => {
            let req = CreateAiSessionRequest {
                provider_id,
                project_path: project_path.unwrap_or_default(),
                title,
                creation_mode,
                terminal_session_id,
            };
            match create_ai_session_with_id_inner(ai_session_id, req, true).await {
                Ok(_) => {
                    let _ = app.emit(WORKSPACE_CHANGED_EVENT, ());
                    send_cloud_snapshots(tx, device_id).await;
                }
                Err(error) => {
                    emit_ai_chat_error(
                        app,
                        ai_session_id,
                        &format!("移动端创建会话同步失败：{error}"),
                    );
                }
            }
        }
        RealtimeMessage::AiMessageSend {
            ai_session_id,
            content,
            ..
        } => {
            if let Some(session) = load_local_sessions()
                .unwrap_or_default()
                .into_iter()
                .find(|session| session.id == ai_session_id)
            {
                let project_path = session.summary.unwrap_or_default();
                if project_path.trim().is_empty() {
                    emit_ai_chat_error(app, ai_session_id, "当前 AI 会话没有项目路径。");
                    return;
                }
                let _ = save_local_message(ai_session_id, AiMessageRole::User, &content);
                emit_ai_history_changed(app, ai_session_id);
                let result = run_ai_chat(
                    app.clone(),
                    RunAiChatRequest {
                        ai_session_id,
                        project_path,
                        prompt: content,
                    },
                )
                .await;
                match result {
                    Ok(text) => {
                        emit_ai_history_changed(app, ai_session_id);
                        let _ = tx.send(RealtimeMessage::AiMessageDone {
                            device_id,
                            ai_session_id,
                            status: AiSessionStatus::Idle,
                            summary: Some(text.chars().take(160).collect()),
                        });
                    }
                    Err(error) => {
                        emit_ai_history_changed(app, ai_session_id);
                        let _ = tx.send(RealtimeMessage::AiMessageDone {
                            device_id,
                            ai_session_id,
                            status: AiSessionStatus::Failed,
                            summary: Some(error),
                        });
                    }
                }
                send_cloud_snapshots(tx, device_id).await;
            }
        }
        RealtimeMessage::AiHistoryRequest {
            ai_session_id,
            request_id,
            ..
        } => {
            let messages = load_local_history(ai_session_id).unwrap_or_default();
            let _ = tx.send(RealtimeMessage::AiHistoryResponse {
                device_id,
                ai_session_id,
                request_id,
                messages,
            });
        }
        RealtimeMessage::AiSessionArchive {
            ai_session_id,
            archived,
            ..
        } => {
            if set_local_session_archived(ai_session_id, archived).is_ok() {
                let _ = app.emit(WORKSPACE_CHANGED_EVENT, ());
                send_cloud_snapshots(tx, device_id).await;
            }
        }
        _ => {}
    }
}

fn websocket_url(server: &str, token: &str, path: &str) -> Result<String, String> {
    let server = server.trim_end_matches('/');
    let base = if let Some(rest) = server.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = server.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err("server must start with http:// or https://".to_string());
    };
    Ok(format!("{base}{path}?token={token}"))
}

fn spawn_shell_reader_with_buffer(
    app: AppHandle,
    ai_session_id: Uuid,
    mut reader: Box<dyn Read + Send>,
    output: std::sync::Arc<Mutex<String>>,
) {
    thread::spawn(move || {
        let _ = app.emit(
            SHELL_SESSION_STATUS_EVENT,
            ShellSessionStatusEvent {
                ai_session_id,
                status: "running".to_string(),
                message: None,
            },
        );
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = app.emit(
                        SHELL_SESSION_STATUS_EVENT,
                        ShellSessionStatusEvent {
                            ai_session_id,
                            status: "exited".to_string(),
                            message: None,
                        },
                    );
                    break;
                }
                Ok(size) => {
                    let chunk = String::from_utf8_lossy(&buffer[..size]).to_string();
                    if let Ok(mut output) = output.lock() {
                        output.push_str(&chunk);
                        if output.len() > 256_000 {
                            let keep_from = output.len().saturating_sub(192_000);
                            output.replace_range(..keep_from, "");
                        }
                    }
                    let _ = app.emit(
                        SHELL_TERMINAL_OUTPUT_EVENT,
                        ShellTerminalEvent {
                            ai_session_id,
                            chunk,
                        },
                    );
                }
                Err(error) => {
                    let _ = app.emit(
                        SHELL_SESSION_STATUS_EVENT,
                        ShellSessionStatusEvent {
                            ai_session_id,
                            status: "failed".to_string(),
                            message: Some(error.to_string()),
                        },
                    );
                    break;
                }
            }
        }
    });
}

fn emit_ai_chat_status(app: &AppHandle, ai_session_id: Uuid, text: &str) {
    let segment = serde_json::json!({
        "type": "status",
        "stepId": format!("status-{}", text),
        "label": text,
        "icon": "think",
    });
    let _ = app.emit(
        AI_CHAT_OUTPUT_EVENT,
        AiChatOutputEvent {
            ai_session_id,
            kind: "status".to_string(),
            text: Some(text.to_string()),
            step_id: Some(format!("status-{}", text)),
            segment: Some(segment.clone()),
        },
    );
    send_cloud_ai_chat_output(
        app,
        ai_session_id,
        "status",
        Some(text.to_string()),
        Some(format!("status-{}", text)),
        Some(segment),
    );
}

fn emit_ai_history_changed(app: &AppHandle, ai_session_id: Uuid) {
    let _ = app.emit(
        AI_HISTORY_CHANGED_EVENT,
        serde_json::json!({ "aiSessionId": ai_session_id }),
    );
    let _ = app.emit(WORKSPACE_CHANGED_EVENT, ());
}

fn emit_ai_chat_step(
    app: &AppHandle,
    ai_session_id: Uuid,
    kind: &str,
    step_id: &str,
    segment: serde_json::Value,
) {
    let cloud_segment = segment.clone();
    let _ = app.emit(
        AI_CHAT_OUTPUT_EVENT,
        AiChatOutputEvent {
            ai_session_id,
            kind: kind.to_string(),
            text: None,
            step_id: Some(step_id.to_string()),
            segment: Some(segment),
        },
    );
    send_cloud_ai_chat_output(
        app,
        ai_session_id,
        kind,
        None,
        Some(step_id.to_string()),
        Some(cloud_segment),
    );
}

fn emit_ai_chat_done(app: &AppHandle, ai_session_id: Uuid, text: &str) {
    let segment = serde_json::json!({
        "type": "text",
        "text": text,
    });
    let _ = app.emit(
        AI_CHAT_OUTPUT_EVENT,
        AiChatOutputEvent {
            ai_session_id,
            kind: "done".to_string(),
            text: Some(text.to_string()),
            step_id: None,
            segment: Some(segment.clone()),
        },
    );
    send_cloud_ai_chat_output(
        app,
        ai_session_id,
        "done",
        Some(text.to_string()),
        None,
        Some(segment),
    );
}

fn emit_ai_chat_delta(app: &AppHandle, ai_session_id: Uuid, delta: &str, full_text: &str) {
    let segment = serde_json::json!({
        "type": "text",
        "text": full_text,
    });
    let _ = app.emit(
        AI_CHAT_OUTPUT_EVENT,
        AiChatOutputEvent {
            ai_session_id,
            kind: "delta".to_string(),
            text: Some(delta.to_string()),
            step_id: None,
            segment: Some(segment.clone()),
        },
    );
    send_cloud_ai_chat_output(
        app,
        ai_session_id,
        "delta",
        Some(delta.to_string()),
        None,
        Some(segment),
    );
}

fn emit_ai_chat_error(app: &AppHandle, ai_session_id: Uuid, text: &str) {
    emit_ai_chat_error_with_title(app, ai_session_id, "AI 执行失败", text);
}

fn emit_ai_chat_error_for_provider(
    app: &AppHandle,
    ai_session_id: Uuid,
    provider_id: &str,
    text: &str,
) {
    emit_ai_chat_error_with_title(
        app,
        ai_session_id,
        &format!("{} 执行失败", provider_display_name(provider_id)),
        text,
    );
}

fn emit_ai_chat_error_with_title(app: &AppHandle, ai_session_id: Uuid, title: &str, text: &str) {
    let segment = serde_json::json!({
        "type": "error",
        "title": title,
        "message": text,
    });
    let _ = app.emit(
        AI_CHAT_OUTPUT_EVENT,
        AiChatOutputEvent {
            ai_session_id,
            kind: "error".to_string(),
            text: Some(text.to_string()),
            step_id: None,
            segment: Some(segment.clone()),
        },
    );
    send_cloud_ai_chat_output(
        app,
        ai_session_id,
        "error",
        Some(text.to_string()),
        None,
        Some(segment),
    );
}

fn send_cloud_ai_chat_output(
    app: &AppHandle,
    ai_session_id: Uuid,
    kind: &str,
    text: Option<String>,
    step_id: Option<String>,
    segment: Option<serde_json::Value>,
) {
    let Some(cloud) = app.try_state::<Arc<DesktopCloudSync>>() else {
        return;
    };
    let Some(config) = cloud.config() else {
        return;
    };
    let segment = segment.and_then(|value| serde_json::from_value::<ChatSegment>(value).ok());
    cloud.send(RealtimeMessage::AiChatOutput {
        device_id: config.device_id,
        ai_session_id,
        kind: kind.to_string(),
        text,
        step_id,
        segment,
    });
}

fn codex_desktop_developer_instructions() -> &'static str {
    r#"你正在 Codex Desktop 的聊天页中工作。当前终端页是独立 shell，不用于 AI 回复。

行为要求：
- 如果用户要求“扫描、查看、检查、分析项目、找入口、看目录、看文件、排查问题”，不要只说明计划，必须直接执行必要的读取/命令来完成检查。
- 可以运行只读命令，例如 pwd、ls、find、rg、sed、cat、git status。
- 回复要直接给结论，并简要说明你实际查看了什么。
- 如果需要修改文件，先按正常 Codex 行为执行，再总结改动。"#
}

fn claude_desktop_prompt(user_prompt: &str) -> String {
    format!(
        r#"你正在 AI 工作台桌面端的聊天页中工作。当前终端页是独立 shell，不用于 AI 回复。

行为要求：
- 回复使用中文，直接给结论，并简要说明你实际查看了什么。
- 如果用户要求“扫描、查看、检查、分析项目、找入口、看目录、看文件、排查问题”，不要只说明计划，必须直接执行必要的读取/命令来完成检查。
- 默认保持保守，只读优先；如果需要修改文件，先按 Claude Code 的权限模式执行，再总结改动。

用户请求：
{user_prompt}"#
    )
}

fn codex_completed_status(item: &serde_json::Value) -> &'static str {
    if item
        .get("exit_code")
        .and_then(|value| value.as_i64())
        .is_some_and(|code| code != 0)
        || item
            .get("status")
            .and_then(|value| value.as_str())
            .is_some_and(|status| matches!(status, "failed" | "error"))
    {
        "error"
    } else {
        "success"
    }
}

fn codex_item_segment(
    item: &serde_json::Value,
    status: &str,
) -> Option<(String, serde_json::Value)> {
    let step_id = item
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("codex-step")
        .to_string();
    let item_type = item
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("step");
    let raw_json = serde_json::to_string_pretty(item).unwrap_or_else(|_| item.to_string());
    let segment = match item_type {
        "reasoning" => serde_json::json!({
            "type": "thought",
            "stepId": step_id,
            "title": if status == "running" { "思考中" } else { "已思考" },
            "text": item
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or(if status == "running" { "Codex 正在推理..." } else { "推理完成" }),
            "collapsed": status != "running",
        }),
        "command_execution" => {
            let command = item
                .get("command")
                .and_then(|value| value.as_str())
                .or_else(|| item.get("cmd").and_then(|value| value.as_str()))
                .unwrap_or("");
            let output = item
                .get("output")
                .and_then(|value| value.as_str())
                .or_else(|| item.get("stdout").and_then(|value| value.as_str()))
                .or_else(|| {
                    item.get("aggregated_output")
                        .and_then(|value| value.as_str())
                })
                .unwrap_or(&raw_json);
            serde_json::json!({
                "type": "tool",
                "stepId": step_id,
                "toolName": if command.is_empty() { "命令执行" } else { "运行命令" },
                "command": command,
                "status": status,
                "summary": if status == "running" { "正在运行命令" } else { "命令已完成" },
                "output": if status == "running" { serde_json::Value::Null } else { serde_json::Value::String(output.to_string()) },
            })
        }
        "file_change" => serde_json::json!({
            "type": "tool",
            "stepId": step_id,
            "toolName": "文件修改",
            "status": status,
            "summary": if status == "running" { "正在修改文件" } else { "文件修改完成" },
            "input": raw_json,
        }),
        "agent_message" | "agentMessage" | "assistant_message" | "assistantMessage" => return None,
        "user_message" | "userMessage" => {
            let output = extract_user_request_text(&extract_assistant_text(&raw_json));
            serde_json::json!({
                "type": "tool",
                "stepId": step_id,
                "toolName": item_type,
                "status": status,
                "summary": if status == "running" { format!("正在处理: {item_type}") } else { format!("已处理: {item_type}") },
                "output": if status == "running" { serde_json::Value::Null } else { serde_json::Value::String(output) },
            })
        }
        other => serde_json::json!({
            "type": "tool",
            "stepId": step_id,
            "toolName": other,
            "status": status,
            "summary": if status == "running" { format!("正在处理：{other}") } else { format!("已处理：{other}") },
            "output": if status == "running" { serde_json::Value::Null } else { serde_json::Value::String(extract_assistant_text(&raw_json)) },
        }),
    };
    Some((step_id, segment))
}

fn start_shell_pty_for_session(
    app: &AppHandle,
    manager: &ShellPtySessionManager,
    ai_session_id: Uuid,
    cwd: &str,
) -> Result<(), String> {
    {
        let mut sessions = manager
            .sessions
            .lock()
            .map_err(|_| "shell session manager lock poisoned".to_string())?;
        if let Some(mut old_session) = sessions.remove(&ai_session_id) {
            let _ = old_session.child.kill();
        }
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let mut command = CommandBuilder::new(shell);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("LANG", "zh_CN.UTF-8");
    command.env("LC_CTYPE", "zh_CN.UTF-8");
    command.env("LC_ALL", "zh_CN.UTF-8");
    command.env("QUOTING_STYLE", "literal");
    command.env("COLUMNS", "100");
    command.env("LINES", "30");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let output = std::sync::Arc::new(Mutex::new(String::new()));
    manager
        .sessions
        .lock()
        .map_err(|_| "pty session manager lock poisoned".to_string())?
        .insert(
            ai_session_id,
            ShellPtySessionHandle {
                child,
                master: pair.master,
                writer,
                output: output.clone(),
            },
        );
    spawn_shell_reader_with_buffer(app.clone(), ai_session_id, reader, output);
    Ok(())
}

async fn list_tmux_sessions() -> Result<Vec<TerminalSession>, String> {
    let output = run_output(
        "tmux",
        &[
            "list-panes",
            "-a",
            "-F",
            "#{session_name}:#{window_index}.#{pane_index}|#{session_name}|#{window_name}|#{pane_current_path}|#{pane_current_command}",
        ],
    )
    .await?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('|');
            let target = parts.next()?.trim();
            let session_name = parts.next().unwrap_or("").trim();
            let window_name = parts.next().unwrap_or("").trim();
            let cwd = parts.next().unwrap_or("").trim();
            let command = parts.next().unwrap_or("").trim();
            if target.is_empty() {
                return None;
            }
            let display_name = if window_name.is_empty() {
                session_name.to_string()
            } else {
                format!("{session_name}/{window_name}")
            };
            Some(TerminalSession {
                session_id: format!("tmux:{target}"),
                name: display_name,
                backend: TerminalBackend::Tmux,
                tool: detect_ai_tool(command),
                status: SessionStatus::Running,
                cwd: (!cwd.is_empty()).then_some(cwd.to_string()),
                recent_output: (!command.is_empty()).then_some(format!("当前命令：{command}")),
            })
        })
        .collect())
}

async fn list_screen_sessions() -> Result<Vec<TerminalSession>, String> {
    let output = run_output("screen", &["-ls"]).await?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if !trimmed.contains('.') || !trimmed.contains('\t') {
                return None;
            }
            let first = trimmed.split_whitespace().next()?;
            let name = first.split_once('.').map(|(_, name)| name).unwrap_or(first);
            Some(TerminalSession {
                session_id: format!("screen:{name}"),
                name: name.to_string(),
                backend: TerminalBackend::Screen,
                tool: detect_ai_tool(name),
                status: SessionStatus::Running,
                cwd: None,
                recent_output: None,
            })
        })
        .collect())
}

async fn run_output(binary: &str, args: &[&str]) -> Result<String, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(binary)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| format!("{binary} timed out"))?
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn send_text_to_terminal(session_id: &str, input: &str, submit: bool) -> Result<(), String> {
    let (backend, target) = parse_terminal_session_id(session_id)?;
    match backend {
        TerminalBackend::Tmux => {
            let status = Command::new("tmux")
                .args(["send-keys", "-t", target, "-l", input])
                .status()
                .await
                .map_err(|error| error.to_string())?;
            if !status.success() {
                return Err("failed to send text to tmux".to_string());
            }
            if submit {
                let enter_status = Command::new("tmux")
                    .args(["send-keys", "-t", target, "Enter"])
                    .status()
                    .await
                    .map_err(|error| error.to_string())?;
                if !enter_status.success() {
                    return Err("failed to send enter to tmux".to_string());
                }
            }
            Ok(())
        }
        TerminalBackend::Screen => {
            let text = if submit {
                format!("{input}\n")
            } else {
                input.to_string()
            };
            let status = Command::new("screen")
                .args(["-S", target, "-X", "stuff", &text])
                .status()
                .await
                .map_err(|error| error.to_string())?;
            status
                .success()
                .then_some(())
                .ok_or_else(|| "failed to send text to screen".to_string())
        }
    }
}

async fn capture_recent_output(session_id: &str, lines: usize) -> Result<String, String> {
    let (backend, target) = parse_terminal_session_id(session_id)?;
    match backend {
        TerminalBackend::Tmux => {
            let line_arg = format!("-{lines}");
            run_output("tmux", &["capture-pane", "-pt", target, "-S", &line_arg]).await
        }
        TerminalBackend::Screen => Ok(String::new()),
    }
}

async fn wait_for_ai_output(
    session_id: &str,
    before_output: &str,
    prompt: &str,
) -> Result<String, String> {
    let mut best_output = String::new();
    for attempt in 0..20 {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let after_output = capture_recent_output(session_id, 220).await?;
        let screen_output = extract_reply_from_current_screen(&after_output, prompt);
        let new_output = extract_new_terminal_output(before_output, &after_output, prompt);
        let output = if screen_output.trim().len() >= new_output.trim().len() {
            screen_output
        } else {
            new_output
        };
        if output.trim().len() > best_output.trim().len() {
            best_output = output.clone();
        }
        if is_substantive_ai_output(&output) {
            return Ok(output);
        }
        if attempt >= 3 && !best_output.trim().is_empty() && !is_codex_working_only(&best_output) {
            return Ok(best_output);
        }
    }
    Ok(best_output)
}

fn is_substantive_ai_output(output: &str) -> bool {
    let meaningful_lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !is_terminal_status_line(line))
        .count();
    meaningful_lines > 0
}

fn is_codex_working_only(output: &str) -> bool {
    let lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    !lines.is_empty() && lines.iter().all(|line| is_terminal_status_line(line))
}

fn extract_new_terminal_output(before: &str, after: &str, prompt: &str) -> String {
    let before = normalize_terminal_text(before);
    let after = normalize_terminal_text(after);
    let prompt = normalize_prompt(prompt);
    let candidate = if after.starts_with(&before) {
        after[before.len()..].to_string()
    } else {
        let before_lines = before
            .lines()
            .map(normalize_line_for_compare)
            .collect::<Vec<_>>();
        let after_lines = after.lines().collect::<Vec<_>>();
        let common_prefix = before_lines
            .iter()
            .zip(after_lines.iter())
            .take_while(|(left, right)| **left == normalize_line_for_compare(right))
            .count();
        if common_prefix > 0 && common_prefix < after_lines.len() {
            after_lines[common_prefix..].join("\n")
        } else {
            after
                .lines()
                .filter(|line| {
                    let normalized = normalize_line_for_compare(line);
                    !normalized.is_empty()
                        && !before_lines
                            .iter()
                            .any(|before_line| before_line == &normalized)
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    };
    candidate
        .lines()
        .filter(|line| {
            let normalized = normalize_prompt(line);
            !normalized.is_empty()
                && normalized != prompt
                && normalized != format!("> {prompt}")
                && normalized != format!("› {prompt}")
                && normalized != format!("$ {prompt}")
                && !is_terminal_status_line(&normalized)
                && !is_tool_trace_line(&normalized)
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn extract_reply_from_current_screen(after: &str, prompt: &str) -> String {
    let prompt = normalize_prompt(prompt);
    let lines = normalize_terminal_text(after)
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let prompt_index = lines.iter().rposition(|line| {
        normalize_prompt(line) == prompt || normalize_prompt(line) == format!("> {prompt}")
    });
    let Some(index) = prompt_index else {
        return String::new();
    };
    let mut reply_lines = Vec::new();
    for line in lines.iter().skip(index + 1) {
        let normalized = normalize_prompt(line);
        if is_user_prompt_line(line) || is_session_status_line(&normalized) {
            break;
        }
        if !normalized.is_empty()
            && normalized != prompt
            && !is_terminal_status_line(&normalized)
            && !is_tool_trace_line(&normalized)
        {
            reply_lines.push(line.clone());
        }
    }
    reply_lines.join("\n").trim().to_string()
}

fn is_user_prompt_line(value: &str) -> bool {
    value.trim_start().starts_with('›')
}

fn is_session_status_line(value: &str) -> bool {
    value.contains("· ~/") || value.contains("· /")
}

fn normalize_terminal_text(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn normalize_line_for_compare(line: &str) -> String {
    normalize_prompt(line)
}

fn normalize_prompt(value: &str) -> String {
    value
        .trim()
        .trim_start_matches(['>', '›', '$', '❯', '❮', '┃', '|', '│', ' '])
        .trim()
        .to_string()
}

fn is_terminal_status_line(value: &str) -> bool {
    let value = normalize_prompt(value);
    value.contains("Working")
        || value.contains("esc to interrupt")
        || value.starts_with("Use /skills")
        || value.starts_with("/ for commands")
        || value.starts_with("! for shell commands")
        || value.starts_with("gpt-")
        || value.starts_with("model:")
        || value.starts_with("directory:")
        || value.starts_with("Tip:")
        || value.starts_with("OpenAI Codex")
}

fn is_tool_trace_line(value: &str) -> bool {
    let value = normalize_prompt(value);
    value == "Explored"
        || value.starts_with("Read ")
        || value.starts_with("List ")
        || value.starts_with("Bash ")
        || value.starts_with("Edit ")
        || value.starts_with("Search ")
        || value.starts_with("Grep ")
        || value.starts_with("Open ")
        || value.starts_with("Run ")
        || value.starts_with('└')
        || value.starts_with('├')
        || value.starts_with('│')
        || value.starts_with("• Explored")
}

fn parse_terminal_session_id(session_id: &str) -> Result<(TerminalBackend, &str), String> {
    let (backend, target) = session_id
        .split_once(':')
        .ok_or_else(|| "session id must be backend:target".to_string())?;
    if target.trim().is_empty() {
        return Err("session target cannot be empty".to_string());
    }
    let backend = match backend {
        "tmux" => TerminalBackend::Tmux,
        "screen" => TerminalBackend::Screen,
        _ => return Err(format!("unsupported terminal backend: {backend}")),
    };
    Ok((backend, target))
}

fn default_providers() -> Vec<AiProviderDefinition> {
    vec![
        AiProviderDefinition {
            id: "codex".to_string(),
            name: "Codex".to_string(),
            command: "codex".to_string(),
            built_in: true,
            enabled: true,
        },
        AiProviderDefinition {
            id: "claude".to_string(),
            name: "Claude Code".to_string(),
            command: "claude".to_string(),
            built_in: true,
            enabled: true,
        },
        AiProviderDefinition {
            id: "opencode".to_string(),
            name: "OpenCode".to_string(),
            command: "opencode".to_string(),
            built_in: true,
            enabled: true,
        },
        AiProviderDefinition {
            id: "deepseek".to_string(),
            name: "DeepSeek TUI".to_string(),
            command: "deepseek".to_string(),
            built_in: true,
            enabled: true,
        },
    ]
}

fn provider_display_name(provider_id: &str) -> &'static str {
    match provider_id {
        "codex" => "Codex",
        "claude" => "Claude Code",
        "opencode" => "OpenCode",
        "deepseek" => "DeepSeek",
        _ => "AI",
    }
}

async fn git_status(path: String) -> Result<GitStatus, String> {
    let branch = Command::new("git")
        .args(["-C", &path, "branch", "--show-current"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| error.to_string())
        .ok()
        .and_then(|output| {
            output
                .status
                .success()
                .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        })
        .filter(|value| !value.is_empty());
    let output = Command::new("git")
        .args(["-C", &path, "status", "--short"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let files = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    Ok(GitStatus {
        path,
        branch,
        dirty: !files.is_empty(),
        files,
    })
}

fn db_path() -> PathBuf {
    std::env::var("AI_WORKBENCH_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".ai-workbench").join("history.db")
        })
}

fn app_data_dir() -> PathBuf {
    db_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn cloud_config_path() -> PathBuf {
    app_data_dir().join(CLOUD_CONFIG_FILE)
}

fn save_cloud_config(config: &CloudSyncConfig) -> std::io::Result<()> {
    let path = cloud_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    std::fs::write(path, content)
}

fn load_cloud_config() -> std::io::Result<Option<CloudSyncConfig>> {
    let path = cloud_config_path();
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path)?;
    let config = serde_json::from_str::<CloudSyncConfig>(&content)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    Ok(Some(config))
}

fn codex_home() -> PathBuf {
    std::env::var("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".codex")
        })
}

fn infer_provider_session_id(session: &AiSession) -> Option<String> {
    if session.provider_id != "codex" {
        return None;
    }
    let index_path = codex_home().join("session_index.jsonl");
    let content = std::fs::read_to_string(index_path).ok()?;
    let mut entries = content
        .lines()
        .filter_map(|line| serde_json::from_str::<CodexSessionIndexEntry>(line).ok())
        .filter(|entry| entry.thread_name == session.title)
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let project_path = session.summary.as_deref();
    if let Some(project_path) = project_path {
        if let Some(entry) = entries.iter().find(|entry| {
            codex_session_cwd(&entry.id)
                .as_deref()
                .is_some_and(|cwd| cwd == project_path)
        }) {
            return Some(entry.id.clone());
        }
    }
    entries.first().map(|entry| entry.id.clone())
}

fn codex_session_cwd(session_id: &str) -> Option<String> {
    let sessions_dir = codex_home().join("sessions");
    let path = find_codex_session_file(&sessions_dir, session_id)?;
    let first_line = std::fs::read_to_string(path)
        .ok()?
        .lines()
        .next()?
        .to_string();
    let meta = serde_json::from_str::<CodexSessionMetaLine>(&first_line).ok()?;
    (meta.kind == "session_meta" && meta.payload.id == session_id)
        .then_some(meta.payload.cwd)
        .flatten()
}

fn find_codex_session_file(dir: &std::path::Path, session_id: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()? {
        let path = entry.ok()?.path();
        if path.is_dir() {
            if let Some(found) = find_codex_session_file(&path, session_id) {
                return Some(found);
            }
        } else if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.contains(session_id) && name.ends_with(".jsonl"))
        {
            return Some(path);
        }
    }
    None
}

fn open_local_db() -> rusqlite::Result<Connection> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    Connection::open(path)
}

fn ensure_local_db() -> rusqlite::Result<()> {
    let conn = open_local_db()?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS local_projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          git_branch TEXT,
          git_dirty INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS local_ai_sessions (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          terminal_session_id TEXT,
          provider_session_id TEXT,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT,
          archived_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS local_ai_messages (
          id TEXT PRIMARY KEY,
          ai_session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        "#,
    )?;
    let _ = conn.execute(
        "ALTER TABLE local_ai_sessions ADD COLUMN archived_at TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE local_ai_sessions ADD COLUMN provider_session_id TEXT",
        [],
    );
    conn.execute(
        r#"
        UPDATE local_ai_sessions
        SET title = (
          SELECT CASE
            WHEN length(content) > 24 THEN substr(content, 1, 24) || '...'
            ELSE content
          END
          FROM local_ai_messages
          WHERE ai_session_id = local_ai_sessions.id AND role = 'user'
          ORDER BY created_at ASC
          LIMIT 1
        )
        WHERE title IN ('新的 AI CLI 会话', '接管已有 AI CLI 会话')
          AND EXISTS (
            SELECT 1
            FROM local_ai_messages
            WHERE ai_session_id = local_ai_sessions.id AND role = 'user'
          )
        "#,
        [],
    )?;
    Ok(())
}

fn save_local_project(project: &WorkspaceProject) -> rusqlite::Result<()> {
    ensure_local_db()?;
    let conn = open_local_db()?;
    conn.execute(
        "INSERT OR REPLACE INTO local_projects (id, name, path, git_branch, git_dirty, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            project.id.to_string(),
            project.name,
            project.path,
            project.git_branch,
            i64::from(project.git_dirty),
            project.updated_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn load_local_projects() -> rusqlite::Result<Vec<WorkspaceProject>> {
    ensure_local_db()?;
    let conn = open_local_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, path, git_branch, git_dirty, updated_at FROM local_projects ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let updated_at: String = row.get(5)?;
        Ok(WorkspaceProject {
            id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::new_v4()),
            device_id: Uuid::nil(),
            name: row.get(1)?,
            path: row.get(2)?,
            git_branch: row.get(3)?,
            git_dirty: row.get::<_, i64>(4)? != 0,
            updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at)
                .map(|value| value.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now()),
        })
    })?;
    rows.collect()
}

fn save_local_session(session: &AiSession) -> rusqlite::Result<()> {
    ensure_local_db()?;
    let conn = open_local_db()?;
    conn.execute(
        "INSERT OR REPLACE INTO local_ai_sessions (id, provider_id, terminal_session_id, provider_session_id, title, status, summary, archived_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            session.id.to_string(),
            session.provider_id,
            session.terminal_session_id,
            session.provider_session_id,
            session.title,
            serde_json::to_value(&session.status).unwrap().as_str().unwrap(),
            session.summary,
            session.archived_at.map(|value| value.to_rfc3339()),
            session.updated_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn load_local_sessions() -> rusqlite::Result<Vec<AiSession>> {
    ensure_local_db()?;
    let conn = open_local_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, provider_id, terminal_session_id, provider_session_id, title, status, summary, archived_at, updated_at FROM local_ai_sessions ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let status_text: String = row.get(5)?;
        let archived_at: Option<String> = row.get(7)?;
        let updated_at: String = row.get(8)?;
        Ok(AiSession {
            id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::new_v4()),
            user_id: Uuid::nil(),
            device_id: Uuid::nil(),
            project_id: None,
            provider_id: row.get(1)?,
            terminal_session_id: row.get(2)?,
            provider_session_id: row.get(3)?,
            title: row.get(4)?,
            status: serde_json::from_value(serde_json::Value::String(status_text))
                .unwrap_or(AiSessionStatus::Running),
            summary: row.get(6)?,
            archived_at: archived_at.and_then(|value| {
                chrono::DateTime::parse_from_rfc3339(&value)
                    .map(|value| value.with_timezone(&chrono::Utc))
                    .ok()
            }),
            updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at)
                .map(|value| value.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now()),
        })
    })?;
    rows.collect()
}

fn set_local_session_archived(ai_session_id: Uuid, archived: bool) -> rusqlite::Result<AiSession> {
    ensure_local_db()?;
    let archived_at = archived.then(chrono::Utc::now);
    let updated_at = chrono::Utc::now();
    let conn = open_local_db()?;
    conn.execute(
        "UPDATE local_ai_sessions SET archived_at = ?1, updated_at = ?2 WHERE id = ?3",
        params![
            archived_at.map(|value| value.to_rfc3339()),
            updated_at.to_rfc3339(),
            ai_session_id.to_string(),
        ],
    )?;
    load_local_sessions()?
        .into_iter()
        .find(|session| session.id == ai_session_id)
        .ok_or(rusqlite::Error::QueryReturnedNoRows)
}

fn set_local_session_provider_session_id(
    ai_session_id: Uuid,
    provider_session_id: &str,
) -> rusqlite::Result<()> {
    ensure_local_db()?;
    let conn = open_local_db()?;
    conn.execute(
        "UPDATE local_ai_sessions SET provider_session_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![
            provider_session_id,
            chrono::Utc::now().to_rfc3339(),
            ai_session_id.to_string(),
        ],
    )?;
    Ok(())
}

fn save_local_message(
    ai_session_id: Uuid,
    role: AiMessageRole,
    content: &str,
) -> rusqlite::Result<()> {
    ensure_local_db()?;
    let conn = open_local_db()?;
    let created_at = chrono::Utc::now().to_rfc3339();
    let display_content = if role == AiMessageRole::Assistant {
        extract_assistant_text(content)
    } else {
        content.to_string()
    };
    conn.execute(
        "INSERT INTO local_ai_messages (id, ai_session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            Uuid::new_v4().to_string(),
            ai_session_id.to_string(),
            serde_json::to_value(&role).unwrap().as_str().unwrap(),
            display_content,
            created_at,
        ],
    )?;
    if role == AiMessageRole::User {
        conn.execute(
            r#"
            UPDATE local_ai_sessions
            SET
              title = CASE
                WHEN title IN ('新的 AI CLI 会话', '接管已有 AI CLI 会话') THEN ?1
                ELSE title
              END,
              updated_at = ?2
            WHERE id = ?3
            "#,
            params![
                session_title_from_prompt(content),
                created_at,
                ai_session_id.to_string(),
            ],
        )?;
    } else {
        conn.execute(
            "UPDATE local_ai_sessions SET updated_at = ?1 WHERE id = ?2",
            params![created_at, ai_session_id.to_string()],
        )?;
    }
    Ok(())
}

fn extract_assistant_text(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.is_empty() || !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return content.to_string();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return content.to_string();
    };
    let text = extract_text_from_json_value(&value).trim().to_string();
    if text.is_empty() {
        content.to_string()
    } else {
        text
    }
}

fn extract_user_request_text(content: &str) -> String {
    let Some((_, request)) = content
        .split_once("用户请求：")
        .or_else(|| content.split_once("用户请求:"))
    else {
        return content.trim().to_string();
    };
    request.trim().to_string()
}

fn extract_text_from_json_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.to_string(),
        serde_json::Value::Array(items) => items
            .iter()
            .map(extract_text_from_json_value)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        serde_json::Value::Object(object) => {
            for key in ["text", "result", "output", "message"] {
                if let Some(text) = object.get(key).and_then(|value| value.as_str()) {
                    return text.to_string();
                }
            }
            if let Some(items) = object.get("content").and_then(|value| value.as_array()) {
                return items
                    .iter()
                    .map(|item| {
                        if item.get("type").and_then(|value| value.as_str()) == Some("text") {
                            item.get("text")
                                .and_then(|value| value.as_str())
                                .unwrap_or_default()
                                .to_string()
                        } else {
                            extract_text_from_json_value(item)
                        }
                    })
                    .filter(|text| !text.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            for key in ["message", "delta"] {
                if let Some(nested) = object.get(key).filter(|value| value.is_object()) {
                    let text = extract_text_from_json_value(nested);
                    if !text.trim().is_empty() {
                        return text;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn session_title_from_prompt(prompt: &str) -> String {
    let first_line = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("新的 AI CLI 会话");
    let mut title = first_line.chars().take(24).collect::<String>();
    if first_line.chars().count() > 24 {
        title.push_str("...");
    }
    title
}

fn load_local_history(ai_session_id: Uuid) -> rusqlite::Result<Vec<AiHistoryMessage>> {
    ensure_local_db()?;
    let conn = open_local_db()?;
    let mut stmt = conn.prepare(
        "SELECT role, content, created_at FROM local_ai_messages WHERE ai_session_id = ?1 ORDER BY created_at ASC LIMIT 500",
    )?;
    let rows = stmt.query_map([ai_session_id.to_string()], |row| {
        let role_text: String = row.get(0)?;
        let created_at: String = row.get(2)?;
        Ok(AiHistoryMessage {
            role: serde_json::from_value(serde_json::Value::String(role_text))
                .unwrap_or(AiMessageRole::System),
            content: row.get(1)?,
            created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                .map(|value| value.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now()),
        })
    })?;
    rows.collect()
}
