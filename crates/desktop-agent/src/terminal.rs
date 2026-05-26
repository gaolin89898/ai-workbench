use anyhow::{anyhow, bail, Context};
use remote_term_shared::{
    detect_ai_tool, ControlInput, SessionStatus, TerminalBackend, TerminalSession,
};
use std::process::Stdio;
use tokio::process::Command;

pub struct TerminalManager;

impl TerminalManager {
    pub fn new() -> Self {
        Self
    }

    pub async fn list_sessions(&self) -> anyhow::Result<Vec<TerminalSession>> {
        let mut sessions = Vec::new();
        sessions.extend(self.list_tmux_sessions().await.unwrap_or_default());
        sessions.extend(self.list_screen_sessions().await.unwrap_or_default());
        Ok(sessions)
    }

    pub async fn send_text(&self, session_id: &str, input: &str) -> anyhow::Result<()> {
        let (backend, name) = parse_session_id(session_id)?;
        match backend {
            TerminalBackend::Tmux => {
                run_status(
                    "tmux",
                    &["send-keys", "-t", name, "-l", input],
                    "failed to send text to tmux",
                )
                .await?;
                if input.ends_with('\n') {
                    run_status(
                        "tmux",
                        &["send-keys", "-t", name, "Enter"],
                        "failed to send enter to tmux",
                    )
                    .await?;
                }
            }
            TerminalBackend::Screen => {
                run_status(
                    "screen",
                    &["-S", name, "-X", "stuff", input],
                    "failed to send text to screen",
                )
                .await?;
            }
        }
        Ok(())
    }

    pub async fn send_control(
        &self,
        session_id: &str,
        control: ControlInput,
    ) -> anyhow::Result<()> {
        let (backend, name) = parse_session_id(session_id)?;
        match backend {
            TerminalBackend::Tmux => {
                let key = match control {
                    ControlInput::CtrlC => "C-c",
                    ControlInput::CtrlD => "C-d",
                    ControlInput::Enter => "Enter",
                    ControlInput::ArrowUp => "Up",
                    ControlInput::ArrowDown => "Down",
                };
                run_status(
                    "tmux",
                    &["send-keys", "-t", name, key],
                    "failed to send tmux key",
                )
                .await?;
            }
            TerminalBackend::Screen => {
                let text = match control {
                    ControlInput::CtrlC => "\u{0003}",
                    ControlInput::CtrlD => "\u{0004}",
                    ControlInput::Enter => "\n",
                    ControlInput::ArrowUp | ControlInput::ArrowDown => {
                        bail!("screen arrow controls are not supported in v1")
                    }
                };
                run_status(
                    "screen",
                    &["-S", name, "-X", "stuff", text],
                    "failed to send screen control",
                )
                .await?;
            }
        }
        Ok(())
    }

    pub async fn capture_recent_output(
        &self,
        session_id: &str,
        lines: usize,
    ) -> anyhow::Result<String> {
        let (backend, name) = parse_session_id(session_id)?;
        match backend {
            TerminalBackend::Tmux => {
                let line_arg = format!("-{lines}");
                run_output(
                    "tmux",
                    &["capture-pane", "-pt", name, "-S", &line_arg],
                    "failed to capture tmux output",
                )
                .await
            }
            TerminalBackend::Screen => Ok(String::new()),
        }
    }

    async fn list_tmux_sessions(&self) -> anyhow::Result<Vec<TerminalSession>> {
        let output = run_output(
            "tmux",
            &[
                "list-panes",
                "-a",
                "-F",
                "#{session_name}:#{window_index}.#{pane_index}|#{session_name}|#{window_name}|#{pane_current_path}|#{pane_current_command}",
            ],
            "failed to list tmux panes",
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
                let detection_text = format!("{target} {session_name} {window_name} {command}");
                Some(TerminalSession {
                    session_id: format!("tmux:{target}"),
                    name: display_name,
                    backend: TerminalBackend::Tmux,
                    tool: detect_ai_tool(&detection_text),
                    status: SessionStatus::Running,
                    cwd: (!cwd.is_empty()).then_some(cwd.to_string()),
                    recent_output: (!command.is_empty()).then_some(format!("当前命令：{command}")),
                })
            })
            .collect())
    }

    async fn list_screen_sessions(&self) -> anyhow::Result<Vec<TerminalSession>> {
        let output = run_output("screen", &["-ls"], "failed to list screen sessions").await?;
        let sessions = output
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
            .collect();
        Ok(sessions)
    }
}

fn parse_session_id(session_id: &str) -> anyhow::Result<(TerminalBackend, &str)> {
    let (backend, name) = session_id
        .split_once(':')
        .ok_or_else(|| anyhow!("session id must be backend:name"))?;
    let backend = match backend {
        "tmux" => TerminalBackend::Tmux,
        "screen" => TerminalBackend::Screen,
        _ => bail!("unsupported terminal backend: {backend}"),
    };
    if name.trim().is_empty() {
        bail!("session name cannot be empty");
    }
    Ok((backend, name))
}

async fn run_output(binary: &str, args: &[&str], context: &str) -> anyhow::Result<String> {
    let output = Command::new(binary)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .with_context(|| format!("{context}: could not start {binary}"))?;
    if !output.status.success() {
        bail!(
            "{context}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn run_status(binary: &str, args: &[&str], context: &str) -> anyhow::Result<()> {
    let output = Command::new(binary)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .with_context(|| format!("{context}: could not start {binary}"))?;
    if !output.status.success() {
        bail!(
            "{context}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tmux_session_ids() {
        let (backend, name) = parse_session_id("tmux:codex").unwrap();
        assert_eq!(backend, TerminalBackend::Tmux);
        assert_eq!(name, "codex");
    }

    #[test]
    fn rejects_bad_session_ids() {
        assert!(parse_session_id("codex").is_err());
        assert!(parse_session_id("unknown:codex").is_err());
    }
}
