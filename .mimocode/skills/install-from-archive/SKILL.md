---
name: install-from-archive
description: Install software from a compressed archive (tar.gz, zip, exe, deb, rpm). Inspects the file, extracts it, identifies the install method, resolves dependencies, installs, and verifies.
---

# Install Software From Archive

Handles the common workflow where the user drops a compressed file and asks to install it.

## Procedure

### 1. Inspect the file

```bash
file <path>          # confirm type
ls -lh <path>        # check size
```

### 2. Peek inside without extracting

```bash
tar -tzf <path> | head -30   # tar.gz
unzip -l <path> | head -30   # zip
```

Identify the structure: is there a `README`, `install.sh`, `.deb`, `.rpm`, a flat directory, or a bare binary?

### 3. Extract

```bash
cd <parent-dir> && tar -xzf <file>      # tar.gz
cd <parent-dir> && unzip <file>          # zip
```

If nested archives (common with Ubuntu PPA-style tarballs), extract the inner one too.

### 4. Determine install method

| Signal | Action |
|--------|--------|
| `.deb` file | `sudo dpkg -i *.deb && sudo apt-get install -f` |
| `.rpm` file | `sudo rpm -i *.rpm` or `sudo dnf localinstall *.rpm` |
| `install.sh` / `setup.sh` | Review script first, then run |
| `configure && make && make install` | Build from source |
| Single executable | `chmod +x` + move to `/usr/local/bin` or `~/bin` |
| AppImage | `chmod +x` + move to `~/Applications` |
| Electron/Node app | `npm install` or `pnpm install` in extracted dir |
| Python package | `pip install .` or check `setup.py`/`pyproject.toml` |

### 5. Resolve dependencies

```bash
# Debian/Ubuntu
sudo apt-get install -f

# Check missing shared libs
ldd <binary> | grep "not found"
```

Install any missing system packages before proceeding.

### 6. Install and verify

```bash
# For .deb
sudo dpkg -i *.deb && sudo apt-get install -f

# For source builds
./configure && make -j$(nproc) && sudo make install

# Verify
which <binary>       # or
<binary> --version   # or
<binary> --help
```

### 7. Report

Tell the user:
- What was installed and version
- How to run it
- Any post-install configuration needed
- Any desktop entry created (check `~/.local/share/applications/`)

## Notes

- Always review install scripts before executing them.
- Prefer package managers over manual file placement when available.
- For Ubuntu PPA-style tarballs (tar.gz containing another tar.gz), handle both layers.
- If the software conflicts with an existing installation, warn the user first.
