#!/usr/bin/env bash
set -euo pipefail

USER_NAME="${1:-gl}"
USER_HOME="/home/$USER_NAME"

if ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "User not found: $USER_NAME" >&2
  exit 1
fi

ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
echo "Asia/Shanghai" > /etc/timezone

sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen
sed -i 's/^# *zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen
locale-gen en_US.UTF-8 zh_CN.UTF-8 >/dev/null
update-locale LANG=en_US.UTF-8

if command -v fdfind >/dev/null 2>&1 && [ ! -e /usr/local/bin/fd ]; then
  ln -s /usr/bin/fdfind /usr/local/bin/fd
fi

install -d -o "$USER_NAME" -g "$USER_NAME" \
  "$USER_HOME/workspace" \
  "$USER_HOME/.local" \
  "$USER_HOME/bin" \
  "$USER_HOME/.local/bin" \
  "$USER_HOME/.npm-global"
chown -R "$USER_NAME:$USER_NAME" \
  "$USER_HOME/workspace" \
  "$USER_HOME/.local" \
  "$USER_HOME/bin" \
  "$USER_HOME/.npm-global"

sudo -u "$USER_NAME" npm config set prefix "$USER_HOME/.npm-global" >/dev/null

if command -v corepack >/dev/null 2>&1; then
  corepack enable || true
fi

BASHRC="$USER_HOME/.bashrc"
touch "$BASHRC"
chown "$USER_NAME:$USER_NAME" "$BASHRC"

if ! grep -q '# >>> codex dev env >>>' "$BASHRC"; then
  cat >> "$BASHRC" <<'EOF'

# >>> codex dev env >>>
export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH"
export EDITOR=vim
export PIP_REQUIRE_VIRTUALENV=false

alias ll="ls -alF"
alias la="ls -A"
alias l="ls -CF"
alias grep="grep --color=auto"
alias ..="cd .."
alias c="clear"
alias py="python3"
alias serve="python3 -m http.server"

if command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1; then
  alias fd="fdfind"
fi
# <<< codex dev env <<<
EOF
  chown "$USER_NAME:$USER_NAME" "$BASHRC"
fi

echo "pipx PATH is configured in $BASHRC"
