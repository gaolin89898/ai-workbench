# Tech Stack

## Overview

AI Workbench is a multi-platform AI Agent workspace (similar to Codex Desktop) with three client tiers and a cloud relay backend. It integrates multiple AI CLI tools (Codex, Claude Code, OpenCode) under a unified desktop + mobile interface.

---

## Languages

| Language  | Where                    | Purpose                              |
|-----------|--------------------------|--------------------------------------|
| Go 1.22   | `backend/`               | Cloud relay server                   |
| TypeScript | `apps/desktop/src/`     | Electron desktop app (main + renderer) |
| Dart      | `apps/mobile/`           | Flutter mobile app                   |
| SQL       | `backend/migrations/`    | PostgreSQL schema migrations         |

---

## Frameworks & Runtimes

### Desktop (`apps/desktop/`)
- **Electron 42.5** — Cross-platform desktop shell (main process + renderer process)
- **Vue 3.5** — UI framework for the renderer process
- **Vue Router 4.5** — Client-side routing (hash history)
- **Vite 6.0** — Build tool for renderer; `electron-vite` 2.3 orchestrates main/preload/renderer builds
- **TypeScript 5.6** — Type safety across all desktop code
- **electron-builder 25.1** — Packaging and publishing (Linux, Windows)
- **electron-updater 6.3** — Auto-update from GitHub Releases

### Backend (`backend/`)
- **Go 1.22** — Standard library `net/http` server (Go 1.22+ ServeMux with path parameters)
- **pgx 5.6** — PostgreSQL driver and connection pool (pgxpool)
- **gorilla/websocket 1.5** — WebSocket upgrade and transport
- **golang-jwt/jwt 5.2** — JWT token generation and validation
- **golang.org/x/crypto 0.27** — Password hashing

### Mobile (`apps/mobile/`)
- **Flutter SDK >=3.4** — Cross-platform mobile framework
- **Dart 3.4+**

---

## Key Dependencies

### Desktop (Node.js / npm)
| Package              | Version  | Purpose                                  |
|----------------------|----------|------------------------------------------|
| `better-sqlite3`     | 12.11    | Local SQLite database for chat history    |
| `node-pty`           | 1.0      | Pseudo-terminal for shell sessions        |
| `simple-git`         | 3.27     | Git operations (branch, status)           |
| `ws`                 | 8.18     | WebSocket client for cloud sync           |
| `qrcode`             | 1.5      | QR code generation for device pairing     |
| `@xterm/xterm`       | 6.0      | Terminal emulator in the renderer UI      |
| `@xterm/addon-fit`   | 0.11     | Auto-fit terminal to container            |
| `electron-updater`   | 6.3      | Auto-update from GitHub Releases          |

### Backend (Go)
| Package               | Purpose                                    |
|-----------------------|--------------------------------------------|
| `pgx/v5`              | PostgreSQL connection pool and queries      |
| `gorilla/websocket`   | WebSocket upgrade and bidirectional comm    |
| `golang-jwt/jwt/v5`   | JWT authentication                          |
| `golang.org/x/crypto` | Password hashing (bcrypt)                   |
| `google/uuid`         | UUID generation                             |

### Mobile (Flutter / Dart)
| Package              | Version  | Purpose                                  |
|----------------------|----------|------------------------------------------|
| `http`               | 1.2      | HTTP client                              |
| `web_socket_channel` | 3.0      | WebSocket client                         |
| `shared_preferences` | 2.3      | Local key-value storage (auth tokens)    |
| `mobile_scanner`     | 6.0      | QR code scanner for device pairing       |
| `url_launcher`       | 6.3      | Opening external URLs                    |

---

## Infrastructure

- **PostgreSQL 17** — Primary database (cloud relay), via Docker
- **Docker** — Containerized deployment for backend + PostgreSQL
- **GitHub Actions** — CI/CD for desktop releases (`release-desktop.yml`) and server releases (`release-server.yml`)
- **GitHub Releases** — Distribution channel for desktop auto-updates

---

## Build & Tooling

| Tool         | Purpose                                          |
|--------------|--------------------------------------------------|
| pnpm 10      | Desktop package manager (workspace-aware)         |
| electron-vite| Vite-based Electron build pipeline                |
| Go modules   | Backend dependency management                     |
| Flutter CLI  | Mobile build tooling                              |
| simple-git   | Programmatic git access in desktop                |
| node-pty     | Native PTY binding for shell sessions             |
| better-sqlite3| Native SQLite binding for local data             |

---

## Runtime Requirements

| Component   | Requirement                                    |
|-------------|------------------------------------------------|
| Desktop     | Node.js 22, pnpm 10                            |
| Backend     | Go 1.22+, PostgreSQL 17 (via Docker Compose)  |
| Mobile      | Flutter SDK >= 3.4, Dart 3.4+                  |
| OS          | Linux (primary), Windows (WSL+tmux), macOS     |
