use remote_term_shared::{
    detect_ai_tool, AiHistoryMessage, AiMessageRole, AiProviderDefinition, AiSession,
    AiSessionStatus, DesktopProviderStatus, ProviderAuthStatus, SessionStatus, TerminalBackend,
    TerminalSession, WorkspaceProject,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, process::Stdio};
use tauri::Manager;
use tokio::process::Command;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    code: String,
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

#[tauri::command]
async fn list_sessions() -> Result<Vec<TerminalSession>, String> {
    let mut sessions = Vec::new();
    sessions.extend(list_tmux_sessions().await.unwrap_or_default());
    sessions.extend(list_screen_sessions().await.unwrap_or_default());
    Ok(sessions)
}

#[tauri::command]
async fn pair_desktop(server: String, code: String) -> Result<PairResponse, String> {
    let url = format!("{}/desktop/pair", server.trim_end_matches('/'));
    let name = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "Desktop".to_string());
    let request = PairRequest {
        code,
        name,
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
        .json::<PairResponse>()
        .await
        .map_err(|error| error.to_string())
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
    ensure_local_db().map_err(|error| error.to_string())?;
    let provider = default_providers()
        .into_iter()
        .find(|item| item.id == req.provider_id)
        .ok_or_else(|| "unknown provider".to_string())?;
    let session_id = Uuid::new_v4();
    let terminal_session = match req.creation_mode.as_str() {
        "attach" => req
            .terminal_session_id
            .clone()
            .ok_or_else(|| "terminalSessionId is required for attach mode".to_string())?,
        _ => {
            let tmux_name = format!("ai-{}-{}", req.provider_id, &session_id.to_string()[..8]);
            let status = Command::new("tmux")
                .args([
                    "new-session",
                    "-d",
                    "-s",
                    &tmux_name,
                    "-c",
                    &req.project_path,
                    &provider.command,
                ])
                .status()
                .await
                .map_err(|error| error.to_string())?;
            if !status.success() {
                return Err("failed to create tmux session".to_string());
            }
            format!("tmux:{tmux_name}")
        }
    };
    let session = AiSession {
        id: session_id,
        user_id: Uuid::nil(),
        device_id: Uuid::nil(),
        project_id: None,
        provider_id: req.provider_id,
        terminal_session_id: Some(terminal_session),
        title: req.title,
        status: AiSessionStatus::Running,
        summary: Some(req.project_path),
        archived_at: None,
        updated_at: chrono::Utc::now(),
    };
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
            list_ai_providers,
            detect_ai_providers,
            add_workspace_project,
            choose_workspace_project,
            list_workspace_projects,
            get_git_status,
            create_ai_session,
            append_local_ai_message,
            send_ai_prompt,
            list_local_ai_history,
            list_local_ai_sessions,
            archive_local_ai_session
        ])
        .setup(|app| {
            app.manage(());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
    let output = Command::new(binary)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
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
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        let after_output = capture_recent_output(session_id, 220).await?;
        let mut output = extract_new_terminal_output(before_output, &after_output, prompt);
        if !is_substantive_ai_output(&output) {
            let screen_output = extract_reply_from_current_screen(&after_output, prompt);
            if screen_output.trim().len() > output.trim().len() {
                output = screen_output;
            }
        }
        if is_substantive_ai_output(&output) {
            return Ok(output);
        }
        if output.trim().len() > best_output.trim().len() {
            best_output = output;
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
    lines
        .iter()
        .skip(index + 1)
        .filter(|line| {
            let normalized = normalize_prompt(line);
            !normalized.is_empty()
                && normalized != prompt
                && !is_terminal_status_line(&normalized)
                && !is_tool_trace_line(&normalized)
        })
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
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
        "INSERT OR REPLACE INTO local_ai_sessions (id, provider_id, terminal_session_id, title, status, summary, archived_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            session.id.to_string(),
            session.provider_id,
            session.terminal_session_id,
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
        "SELECT id, provider_id, terminal_session_id, title, status, summary, archived_at, updated_at FROM local_ai_sessions ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let status_text: String = row.get(4)?;
        let archived_at: Option<String> = row.get(6)?;
        let updated_at: String = row.get(7)?;
        Ok(AiSession {
            id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::new_v4()),
            user_id: Uuid::nil(),
            device_id: Uuid::nil(),
            project_id: None,
            provider_id: row.get(1)?,
            terminal_session_id: row.get(2)?,
            title: row.get(3)?,
            status: serde_json::from_value(serde_json::Value::String(status_text))
                .unwrap_or(AiSessionStatus::Running),
            summary: row.get(5)?,
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
