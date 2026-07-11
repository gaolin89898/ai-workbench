#!/usr/bin/env bash
set -euo pipefail

. /etc/os-release
echo "Ubuntu: $PRETTY_NAME"
echo "User: $(whoami)"
echo "Shell: $SHELL"
echo "Timezone: $(cat /etc/timezone)"
locale | grep '^LANG='
git --version
gcc --version | head -n1
g++ --version | head -n1
cmake --version | head -n1
python3 --version
python3 -m pip --version
pipx --version
node --version
npm --version
java -version 2>&1 | head -n1
go version
rg --version | head -n1
fd --version
jq --version
tmux -V
zsh --version
