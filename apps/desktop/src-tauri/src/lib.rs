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
use tokio::io::{AsyncBufReadExt, BufReader};
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunCodexChatRequest {
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
    let started_at = Instant::now();
    eprintln!(
        "[run_codex_chat +{}ms] start session={} cwd={} prompt_len={}",
        started_at.elapsed().as_millis(),
        req.ai_session_id,
        req.project_path,
        req.prompt.len()
    );
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

    let prescan = if should_prescan_project(&user_prompt) {
        Some(
            run_project_prescan(&app, req.ai_session_id, &req.project_path)
                .await
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    let prompt = codex_desktop_prompt(&user_prompt, prescan.as_deref());

    emit_ai_chat_status(&app, req.ai_session_id, "正在启动 Codex exec...");
    let mut command = Command::new("codex");
    command
        .current_dir(&req.project_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(provider_session_id) = session
        .provider_session_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.args([
            "exec",
            "resume",
            "--json",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            provider_session_id,
            &prompt,
        ]);
    } else {
        command.args([
            "exec",
            "--json",
            "-C",
            &req.project_path,
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            &prompt,
        ]);
    }

    let mut child = command.spawn().map_err(|error| {
        eprintln!(
            "[run_codex_chat +{}ms] spawn failed: {error}",
            started_at.elapsed().as_millis()
        );
        error.to_string()
    })?;
    eprintln!(
        "[run_codex_chat +{}ms] spawned codex",
        started_at.elapsed().as_millis()
    );
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture codex stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture codex stderr".to_string())?;
    let stderr_app = app.clone();
    let stderr_session_id = req.ai_session_id;
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut lines = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if !line.trim().is_empty() {
                let _ = (&stderr_app, stderr_session_id);
                lines.push(line);
            }
        }
        lines.join("\n")
    });

    let mut reader = BufReader::new(stdout).lines();
    let mut final_text = String::new();
    let mut provider_session_id = session.provider_session_id.clone();
    let mut completed = false;
    while let Some(line) = reader
        .next_line()
        .await
        .map_err(|error| error.to_string())?
    {
        eprintln!(
            "[run_codex_chat +{}ms] stdout: {line}",
            started_at.elapsed().as_millis()
        );
        completed = handle_codex_json_line(
            &app,
            req.ai_session_id,
            &line,
            &mut provider_session_id,
            &mut final_text,
        );
        if completed {
            break;
        }
    }

    let status = if completed {
        let _ = tokio::time::timeout(Duration::from_millis(250), child.wait()).await;
        None
    } else {
        Some(child.wait().await.map_err(|error| error.to_string())?)
    };
    let stderr_output = if completed {
        String::new()
    } else {
        stderr_task.await.unwrap_or_default()
    };
    if !completed && status.is_some_and(|status| !status.success()) {
        let message = if stderr_output.trim().is_empty() {
            "Codex exec failed".to_string()
        } else {
            stderr_output
        };
        emit_ai_chat_error(&app, req.ai_session_id, &message);
        return Err(message);
    }

    if let Some(provider_session_id) = provider_session_id.filter(|value| !value.trim().is_empty())
    {
        set_local_session_provider_session_id(req.ai_session_id, &provider_session_id)
            .map_err(|error| error.to_string())?;
    }
    if !final_text.trim().is_empty() {
        save_local_message(req.ai_session_id, AiMessageRole::Assistant, &final_text)
            .map_err(|error| error.to_string())?;
        eprintln!(
            "[run_codex_chat +{}ms] saved assistant chars={}",
            started_at.elapsed().as_millis(),
            final_text.len()
        );
    } else {
        eprintln!(
            "[run_codex_chat +{}ms] empty final text",
            started_at.elapsed().as_millis()
        );
        emit_ai_chat_error(&app, req.ai_session_id, "Codex 没有返回可显示的回复。");
        return Err("Codex 没有返回可显示的回复。".to_string());
    }
    Ok(final_text)
}

#[tauri::command]
async fn warmup_codex_session(app: AppHandle, ai_session_id: Uuid) -> Result<AiSession, String> {
    let started_at = Instant::now();
    let mut session = load_local_sessions()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == ai_session_id)
        .ok_or_else(|| "ai session not found".to_string())?;
    if session.provider_id != "codex" {
        return Ok(session);
    }
    if session
        .provider_session_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Ok(session);
    }
    let Some(project_path) = session.summary.clone() else {
        return Ok(session);
    };
    emit_ai_chat_status(&app, ai_session_id, "正在预热 Codex 会话...");
    let prompt = "初始化这个 Codex Desktop 会话。只回复：已就绪。";
    let mut child = Command::new("codex")
        .current_dir(&project_path)
        .args([
            "exec",
            "--json",
            "-C",
            &project_path,
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            prompt,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture codex warmup stdout".to_string())?;
    let mut reader = BufReader::new(stdout).lines();
    while let Some(line) = reader
        .next_line()
        .await
        .map_err(|error| error.to_string())?
    {
        eprintln!(
            "[warmup_codex_session +{}ms] stdout: {line}",
            started_at.elapsed().as_millis()
        );
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(|value| value.as_str()) == Some("thread.started") {
            if let Some(thread_id) = value.get("thread_id").and_then(|value| value.as_str()) {
                session.provider_session_id = Some(thread_id.to_string());
                set_local_session_provider_session_id(ai_session_id, thread_id)
                    .map_err(|error| error.to_string())?;
            }
        }
        if value.get("type").and_then(|value| value.as_str()) == Some("item.completed")
            && value
                .get("item")
                .and_then(|item| item.get("type"))
                .and_then(|value| value.as_str())
                == Some("agent_message")
        {
            break;
        }
    }
    let _ = tokio::time::timeout(Duration::from_millis(250), child.wait()).await;
    emit_ai_chat_status(&app, ai_session_id, "Codex 会话已预热");
    eprintln!(
        "[warmup_codex_session +{}ms] done session={}",
        started_at.elapsed().as_millis(),
        ai_session_id
    );
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            run_codex_chat,
            warmup_codex_session,
            stop_shell_pty,
            is_shell_live,
            list_local_ai_history,
            list_local_ai_sessions,
            archive_local_ai_session
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
                if session.provider_id != "codex" {
                    emit_ai_chat_error(app, ai_session_id, "移动端结构化聊天暂仅支持 Codex。");
                    return;
                }
                let _ = save_local_message(ai_session_id, AiMessageRole::User, &content);
                emit_ai_history_changed(app, ai_session_id);
                let result = run_codex_chat(
                    app.clone(),
                    RunCodexChatRequest {
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

fn emit_ai_chat_error(app: &AppHandle, ai_session_id: Uuid, text: &str) {
    let segment = serde_json::json!({
        "type": "error",
        "title": "Codex 执行失败",
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

fn handle_codex_json_line(
    app: &AppHandle,
    ai_session_id: Uuid,
    line: &str,
    provider_session_id: &mut Option<String>,
    final_text: &mut String,
) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    match value.get("type").and_then(|value| value.as_str()) {
        Some("thread.started") => {
            if let Some(thread_id) = value.get("thread_id").and_then(|value| value.as_str()) {
                *provider_session_id = Some(thread_id.to_string());
            }
            emit_ai_chat_status(app, ai_session_id, "Codex 会话已连接");
        }
        Some("turn.started") => {
            emit_ai_chat_status(app, ai_session_id, "Codex 正在处理...");
        }
        Some("item.started") => {
            if let Some(item) = value.get("item") {
                if let Some((step_id, segment)) = codex_item_segment(item, "running") {
                    emit_ai_chat_step(app, ai_session_id, "step-start", &step_id, segment);
                }
            }
        }
        Some("item.completed") => {
            if let Some(item) = value.get("item") {
                if let Some(text) = codex_agent_message_text(item) {
                    if !final_text.trim().is_empty() {
                        final_text.push_str("\n\n");
                    }
                    final_text.push_str(&text);
                    emit_ai_chat_step(
                        app,
                        ai_session_id,
                        "step-update",
                        "assistant-message",
                        serde_json::json!({
                            "type": "status",
                            "stepId": "assistant-message",
                            "label": "Codex 已生成一段回复，继续等待最终完成信号",
                            "icon": "think",
                        }),
                    );
                } else if let Some((step_id, segment)) =
                    codex_item_segment(item, codex_completed_status(item))
                {
                    emit_ai_chat_step(app, ai_session_id, "step-update", &step_id, segment);
                }
            }
        }
        Some("turn.completed") => {
            if final_text.trim().is_empty() {
                emit_ai_chat_status(app, ai_session_id, "Codex 已完成");
            }
            if !final_text.trim().is_empty() {
                emit_ai_chat_done(app, ai_session_id, final_text);
            }
            return !final_text.trim().is_empty();
        }
        Some("error") => {
            let message = value
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("Codex exec error");
            emit_ai_chat_error(app, ai_session_id, message);
        }
        _ => {}
    }
    false
}

fn codex_agent_message_text(item: &serde_json::Value) -> Option<String> {
    (item.get("type").and_then(|value| value.as_str()) == Some("agent_message"))
        .then(|| item.get("text").and_then(|value| value.as_str()))
        .flatten()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn codex_desktop_prompt(user_prompt: &str, prescan: Option<&str>) -> String {
    let prescan_block = prescan
        .map(|value| {
            format!(
                r#"
后端已经先执行了一次只读项目扫描，结果如下。请基于这些真实结果直接总结，不要再说“我先看”。

```text
{value}
```
"#
            )
        })
        .unwrap_or_default();
    format!(
        r#"你正在 Codex Desktop 的聊天页中工作。当前终端页是独立 shell，不用于 AI 回复。

行为要求：
- 如果用户要求“扫描、查看、检查、分析项目、找入口、看目录、看文件、排查问题”，不要只说明计划，必须直接执行必要的读取/命令来完成检查。
- 可以运行只读命令，例如 pwd、ls、find、rg、sed、cat、git status。
- 回复要直接给结论，并简要说明你实际查看了什么。
- 如果需要修改文件，先按正常 Codex 行为执行，再总结改动。
{prescan_block}

用户请求：
{user_prompt}"#
    )
}

fn should_prescan_project(prompt: &str) -> bool {
    let normalized = prompt.trim().to_lowercase();
    [
        "扫描",
        "扫一下",
        "查看这个项目",
        "看这个项目",
        "项目结构",
        "入口",
        "怎么运行",
        "运行方式",
        "分析项目",
        "检查项目",
    ]
    .iter()
    .any(|keyword| normalized.contains(keyword))
}

async fn run_project_prescan(
    app: &AppHandle,
    ai_session_id: Uuid,
    project_path: &str,
) -> Result<String, std::io::Error> {
    let command = "pwd && printf '\\n--- git status ---\\n' && git status --short --branch 2>/dev/null || true && printf '\\n--- files ---\\n' && find . -maxdepth 2 -type f | sed 's#^./##' | head -80 && printf '\\n--- manifests ---\\n' && for f in package.json pnpm-workspace.yaml Cargo.toml tauri.conf.json docker-compose.yml README.md; do [ -f \"$f\" ] && echo \"### $f\" && sed -n '1,80p' \"$f\"; done";
    emit_ai_chat_step(
        app,
        ai_session_id,
        "step-start",
        "desktop-prescan",
        serde_json::json!({
            "type": "tool",
            "stepId": "desktop-prescan",
            "toolName": "项目扫描",
            "command": command,
            "status": "running",
            "summary": "正在读取当前项目结构",
        }),
    );
    let output = Command::new("bash")
        .current_dir(project_path)
        .args(["-lc", command])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        text.push_str("\n--- stderr ---\n");
        text.push_str(&stderr);
    }
    emit_ai_chat_step(
        app,
        ai_session_id,
        "step-update",
        "desktop-prescan",
        serde_json::json!({
            "type": "tool",
            "stepId": "desktop-prescan",
            "toolName": "项目扫描",
            "command": command,
            "status": if output.status.success() { "success" } else { "error" },
            "summary": "已读取当前项目结构",
            "output": text,
        }),
    );
    Ok(text)
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
        "agent_message" => return None,
        other => serde_json::json!({
            "type": "tool",
            "stepId": step_id,
            "toolName": other,
            "status": status,
            "summary": if status == "running" { format!("正在处理：{other}") } else { format!("已处理：{other}") },
            "output": if status == "running" { serde_json::Value::Null } else { serde_json::Value::String(raw_json) },
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
            id: "gemini".to_string(),
            name: "Gemini".to_string(),
            command: "gemini".to_string(),
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
    conn.execute(
        "INSERT INTO local_ai_messages (id, ai_session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            Uuid::new_v4().to_string(),
            ai_session_id.to_string(),
            serde_json::to_value(&role).unwrap().as_str().unwrap(),
            content,
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
