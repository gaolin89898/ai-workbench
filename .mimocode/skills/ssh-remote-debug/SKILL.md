---
name: ssh-remote-debug
description: Connect to a remote host via SSH with password auth, set up port forwarding, and run diagnostic commands for debugging remote services and processes.
---

# SSH Remote Debug

Handles the repeated workflow of SSH-ing to remote machines (especially feidu internal hosts), forwarding ports, and running diagnostics.

## Procedure

### 1. Establish SSH connection with password

Use the RSSH helper pattern for non-interactive password auth:

```bash
RSSH() {
  SSH_ASKPASS=/tmp/askpass_feidu.sh SSH_ASKPASS_REQUIRE=force \
    setsid -w ssh -p <PORT> -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 \
    <user>@<host> "$@" 2>/dev/null
}
```

The `askpass_feidu.sh` script must exist at `/tmp/askpass_feidu.sh` and echo the password. Create it on first use:

```bash
echo '#!/bin/sh' > /tmp/askpass_feidu.sh
echo 'echo "<password>"' >> /tmp/askpass_feidu.sh
chmod +x /tmp/askpass_feidu.sh
```

### 2. Port forwarding (local forwarding)

Forward a remote port to localhost for local access:

```bash
ssh -p <PORT> -L <LOCAL_PORT>:localhost:<REMOTE_PORT> <user>@<host>
# Example: forward remote 9222 (CDP) to local 9222
ssh -p 1122 -L 9222:localhost:9222 live-pc@r.feidu.fit
```

For background forwarding:

```bash
ssh -fN -p <PORT> -L <LOCAL>:localhost:<REMOTE> <user>@<host>
```

### 3. Common diagnostic sequences

#### System info

```bash
RSSH 'uname -m; echo "---"; lscpu | grep -iE "Architecture|Model name|CPU|Thread|Core"'
```

#### Process check

```bash
RSSH 'pgrep -af <process_name> | head -10'
RSSH 'ps aux | grep <process_name> | grep -v grep'
```

#### Port / service check

```bash
RSSH 'curl -s -m5 http://localhost:<port>/json | head -20'
RSSH 'ss -tlnp | grep <port>'
RSSH 'netstat -tlnp 2>/dev/null | grep <port>'
```

#### Log inspection

```bash
RSSH 'tail -50 /path/to/logfile'
RSSH 'grep -iE "error|fail|crash|timeout" /path/to/logfile | tail -20'
```

#### GPU / display diagnostics

```bash
RSSH 'glxinfo 2>/dev/null | head -20'
RSSH 'cat /proc/$(pgrep -f <app>)/environ 2>/dev/null | tr "\0" "\n" | grep -E "DISPLAY|XAUTHORITY"'
```

#### CDP (Chrome DevTools Protocol) probing

```bash
RSSH 'curl -s -m5 http://localhost:9222/json | python3 -m json.tool | head -30'
```

### 4. Remote script execution

Upload a local script to remote and run it:

```bash
# Upload
cat /tmp/local_script.py | ssh -p <PORT> <user>@<host> 'cat > /tmp/remote_script.py'
# Run
RSSH 'timeout 25 python3 /tmp/remote_script.py'
```

### 5. Cleanup

When done with port forwarding:

```bash
# Find and kill the SSH tunnel
ps aux | grep "ssh -.*-L" | grep -v grep | awk '{print $2}' | xargs kill
# Or just close the session
```

## Known hosts

| Alias | Host | Port | User | Purpose |
|-------|------|------|------|---------|
| live-pc | r.feidu.fit | 1122 | live-pc | Production monitoring, CDP debugging |
| dev-pc | rdev.singzer.cn | 1122 | live-pc | Development, port 9222 forwarding |
| Win7 | r.feidu.fit | 1122 | Win7-64-PDY202501 | Windows remote |

## Notes

- Password auth is via SSH_ASKPASS helper — do not type passwords interactively.
- Always use `ConnectTimeout=15` (or 20) to avoid hanging on unreachable hosts.
- Use `StrictHostKeyChecking=no` for internal hosts that rotate.
- For long-running monitors, use `timeout` to prevent indefinite hangs.
- The RSSH pattern is repeated across many sessions — always use this helper rather than raw ssh with password prompts.
