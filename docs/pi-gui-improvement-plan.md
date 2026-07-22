# 借鉴 pi-gui 改进计划

> 参考项目：[gaolin89898/pi-gui](https://github.com/gaolin89898/pi-gui)
>
> pi-gui 是 `@mariozechner/pi-coding-agent` 的 Electron 桌面外壳。虽然它只对接单一 runtime、无后端/无移动端，
> 但在工程化（分层架构、进程管理、环境托管、E2E 测试、仓库指引）方面有多处值得本项目借鉴的实现。

## 已完成

| 编号 | 项目 | 状态 |
|------|------|------|
| 4 | Windows UTF-8 编码处理 | ✅ 已完成 — `apps/desktop/src/main/windows-utf8-env.ts` |
| 6 | AGENTS.md 仓库指引 | ✅ 已完成 — `AGENTS.md`（项目根目录） |
| 5 | Playwright 分层 E2E | ✅ 已完成 — `apps/desktop/playwright.config.ts` + `tests/` |

## 待实施

### 1. 三层 Provider 分层架构

**优先级：高** ｜ **影响范围：桌面端核心架构**

#### 现状

```
apps/desktop/src/main/
├── codex.ts      # Codex 适配 + spawn 逻辑 + 会话管理
├── claude.ts     # Claude SDK 适配 + spawn 逻辑
├── acp.ts        # OpenCode ACP 适配 + spawn 逻辑
├── mimo.ts       # MiMo 适配 + spawn 逻辑
├── sync.ts       # 云端同步
├── db.ts         # 本地存储
└── ipc.ts        # IPC 路由
```

四个 Provider 的适配逻辑、spawn 逻辑、会话管理全部平铺在 `src/main/` 下，与主进程、同步、存储耦合。新增 Provider 需要改动主进程代码，且无法对适配层独立单测。

#### pi-gui 的做法

三个独立 workspace 包，职责清晰分离：

| 包 | 职责 | 依赖 |
|---|---|---|
| `packages/session-driver` | 纯接口/类型契约，Provider 无关——定义"一个会话驱动该长什么样" | 无（最底层） |
| `packages/catalogs` | workspace/session 的目录状态管理 | session-driver |
| `packages/pi-sdk-driver` | 具体适配层，实现 session-driver 接口，对接 pi-coding-agent | 两者都依赖 |

#### 建议方案

```
packages/
├── session-driver/        # 定义统一的 SessionDriver 接口
│   └── src/
│       ├── index.ts       # 导出 SessionDriver 接口、事件类型、通用类型
│       └── types.ts       # SessionId, SessionEvent, MessageRequest 等
├── catalogs/              # workspace/session 目录状态（可选，与现有 db.ts 职责重叠时合并）
│   └── src/
│       └── index.ts
├── codex-driver/          # 实现 SessionDriver，对接 codex app-server
│   └── src/
│       ├── index.ts
│       └── codex-driver.ts
├── claude-driver/         # 实现 SessionDriver，对接 Claude Agent SDK
│   └── src/
│       ├── index.ts
│       └── claude-driver.ts
├── acp-driver/            # 实现 SessionDriver，对接 OpenCode ACP
│   └── src/
│       ├── index.ts
│       └── acp-driver.ts
└── mimo-driver/           # 实现 SessionDriver，对接 MiMo CLI
    └── src/
        ├── index.ts
        └── mimo-driver.ts
```

`SessionDriver` 接口需覆盖当前四个 Provider 的公共能力：

```typescript
interface SessionDriver {
  createSession(cwd: string, options: SessionOptions): Promise<SessionHandle>;
  resumeSession(sessionId: string, cwd: string): Promise<SessionHandle>;
  sendMessage(handle: SessionHandle, message: string): AsyncIterable<SessionEvent>;
  cancelSession(handle: SessionHandle): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  dispose(): void;
}
```

收益：加新 Provider 时只需新建一个 driver 包，不碰主进程；driver 包可独立单测；跨 Provider 行为有契约约束。

#### 实施步骤

1. 创建 `packages/session-driver`，从现有四个 Provider 文件中提取公共接口
2. 创建第一个 driver 包（建议从 `codex-driver` 开始，Codex 是当前重点体验）
3. 将 `apps/desktop/src/main/codex.ts` 改为依赖 `@ai-workbench/codex-driver`
4. 验证 Codex 会话功能不回归后，逐个迁移其余三个 Provider
5. 更新 `pnpm-workspace.yaml` 和根 `package.json` 的 typecheck 脚本

---

### 2. Supervisor 进程管理模式

**优先级：中** ｜ **影响范围：桌面端 Provider 运行时**

#### 现状

主进程直接 `spawn` CLI 进程，没有进程守护。CLI 崩溃后不会自动重启，运行中发新消息的行为（打断 vs 排队）由各 Provider 自己临时处理，没有统一的消息队列模式。

#### pi-gui 的做法

`pi-sdk-driver` 包内有两个 supervisor 模块：

- **`runtime-supervisor.ts`**：管理 runtime 进程的生命周期（启动、守护、重启、优雅退出）
- **`session-supervisor.ts`**：管理会话生命周期，内置 **steer / followUp** 两种消息队列投递模式
  - `steer`：AI 运行中发新消息，打断当前执行并引导新方向
  - `followUp`：AI 运行中发新消息，排队等当前执行完成后再投递

#### 建议方案

在实施第 1 条（三层分层）时，将 supervisor 作为 `session-driver` 包的一部分：

```
packages/session-driver/src/
├── session-driver.ts          # 接口定义
├── runtime-supervisor.ts      # 进程生命周期管理（启动/守护/重启/退出）
├── session-supervisor.ts      # 会话生命周期 + 消息队列（steer/followUp）
└── session-supervisor-utils.ts # 消息队列工具函数
```

各 Provider driver 包只需实现 `SessionDriver` 接口，supervisor 逻辑由 `session-driver` 统一提供。

收益：CLI 崩溃自动重启、运行中消息统一排队策略、优雅关闭。

---

### 3. 托管运行时环境 + 依赖检测

**优先级：中** ｜ **影响范围：桌面端安装体验**

#### 现状

`providers.ts` 的 `detectAiProviders()` 能检测 CLI 是否安装、版本是否最新，但只能引导用户手动安装。没有托管环境（Python/uv）的检测和引导。本项目运行 Codex/Claude/OpenCode/MiMo，部分 CLI 依赖本机 Node.js/Python 环境，Windows 用户往往缺这些。

#### pi-gui 的做法

三个模块协同：

- **`managed-python-env.ts`**：桌面端自管理 Python/uv 环境，默认指向阿里云 PyPI 镜像（`PIP_INDEX_URL`/`UV_DEFAULT_INDEX`），优先用打包内置的 `resources/runtime/python`
- **`runtime-deps.ts`**：运行时依赖检测（CLI 装没装、版本对不对、运行环境是否就绪）
- **`npm-package-fallback.ts`**：npm 包兜底获取

#### 建议方案

分两步：

1. **短期**：在 `providers.ts` 中增强 `detectAiProviders()`，除了检测 CLI 本身，还检测前置依赖（Node.js 版本、Python 是否可用等），在 UI 上给出更清晰的缺失提示和安装引导链接
2. **长期**：在打包时内置便携 Python/uv runtime（类似 pi-gui 的 `resources/runtime/`），桌面端启动时自动设置 `PIP_INDEX_URL` 指向国内镜像，让依赖 Python 的 CLI 工具开箱即用

可复用已完成的 `windows-utf8-env.ts` 中的 `utf8EnvOverrides()` 来确保托管环境也使用 UTF-8。

---

### 5. Playwright 分层 E2E + 测试约定

**优先级：中** ｜ **影响范围：桌面端测试体系**

#### 现状

测试偏传统：后端 `go test`、桌面端 `pnpm build`、移动端 `flutter analyze` + `flutter test`。缺少真实 Electron 表面的 E2E 覆盖——renderer 行为、IPC 调用、Provider 会话流程、打包后启动等场景没有被自动化测试覆盖。

#### pi-gui 的做法

Playwright E2E 分 4 条 lane，按变更面选最小集跑：

| Lane | 覆盖范围 | 命令 |
|------|---------|------|
| `core` | 后台友好的窗口内 UI 行为（renderer、sidebar、composer、持久化、设置） | `test:e2e:core` |
| `live` | 真实 runtime/provider 的运行、工具调用、审批 | `test:e2e:live` |
| `native` | macOS 系统级表面（文件选择器、剪贴板、图片粘贴） | `test:e2e:native` |
| `production` | 打包后冒烟（.app 启动、安装后重启、发布 ZIP 验证） | `test:prod:packaged-smoke` |

关键约定（写进 `apps/desktop/README.md`）：

- 优先真实点击/输入/键盘快捷键，避免直接 IPC 捷径
- 共享 helper 放 `tests/helpers/electron-app.ts`，不要各写各的 Electron harness
- `core` 和大部分 `live` 脚本自动设 `PI_APP_TEST_MODE=background`
- `native` 脚本自动设 `PI_APP_TEST_MODE=foreground`，可能抢焦点

还有一个 **`dev-reload-probe.ts`** 探针模块 + `test:dev:reload` 测试，验证"改了共享包代码，运行中的窗口能热加载"。

#### 建议方案

适配本项目的 Provider 和平台差异：

```
apps/desktop/tests/
├── helpers/
│   └── electron-app.ts      # 共享 Electron 测试 harness
├── core/                      # 对应 pi-gui core lane
│   ├── sidebar.spec.ts
│   ├── composer.spec.ts
│   ├── persistence.spec.ts
│   └── settings.spec.ts
├── live/                      # 对应 pi-gui live lane（需真实 Provider auth）
│   ├── codex-session.spec.ts
│   ├── claude-session.spec.ts
│   └── tool-calls.spec.ts
└── production/                # 对应 pi-gui production lane
    ├── packaged-smoke.spec.ts
    └── applications-relaunch.spec.ts
```

本项目主推 Windows，`native` lane 的 macOS 系统表面测试可暂缓，重点先做 `core` 和 `production`。

#### 实施步骤

1. 安装 `@playwright/test` 作为 devDependency
2. 创建 `apps/desktop/tests/helpers/electron-app.ts` 共享 harness
3. 创建 `playwright.config.ts`，定义 `core` / `live` / `production` 三条 lane
4. 从 `core` lane 开始，先覆盖 sidebar、composer、settings 等窗口内行为
5. 逐步加入 `production` 的 packaged-smoke 测试

---

### 6. AGENTS.md 分层仓库指引

**优先级：低（但成本极低，可立刻做）** ｜ **影响范围：AI 协作开发规范**

#### 现状

项目有 `.workbuddy/memory` 体系记录工作笔记，但缺一份面向"AI 协作开发"的仓库级规则文件。AI 辅助开发时缺少统一的代码风格、安全边界、验证标准。

#### pi-gui 的做法

根 `AGENTS.md` 作为仓库指引的 source of truth，`CLAUDE.md` 是它的 symlink。规则分 5 类：

- **Workflow**：先定成功标准再写码；小步提交不混改；收尾跑 simplify
- **Product**：桌面工作没在真实 Electron 上验证就不算完；transcript/会话正确性是产品功能不是打磨
- **Safety**：不删用户历史/截图/临时文件；多 agent 时把没编辑的文件当只读
- **Structure**：renderer/main/preload 边界要紧；driver 对上游保持薄，不 fork 不重实现
- **分层**：根 AGENTS.md 管全局，子目录可放局部 AGENTS.md 管局部规则

#### 建议方案

在项目根目录创建 `AGENTS.md`，适配本项目的四端架构和多 Provider 特点：

```markdown
# Repo Guidelines

## Workflow
- 定义成功标准后再编码；不明确时先澄清
- 小步聚焦提交，不混无关改动
- 改动后跑对应验证：后端 go test、桌面端 pnpm build、移动端 flutter analyze

## Product
- 本项目是多端（桌面/移动/后端/管理后台）系统，改动涉及跨端协议时同步更新 docs/protocol.md
- 桌面端工作需在真实 Electron 上验证，不能只靠单元测试
- Provider 适配改动需验证对应 Provider 的会话恢复和执行轨迹

## Safety
- 不删除用户会话历史、SQLite 数据库、缓存
- 多 agent 协作时，未编辑的文件视为只读
- 破坏性命令（git reset --hard 等）需先确认

## Structure
- 保持 renderer/main/preload 边界紧凑，避免向 renderer 暴露过多 Node 能力
- Provider 适配逻辑与主进程逻辑分离（长期目标：迁移到 packages/* driver 包）
- 协议新增字段同步更新桌面端、移动端、backend/internal/protocol、docs/protocol.md

## Source Of Truth
- 根 AGENTS.md 是仓库指令源
- 子目录可放置局部 AGENTS.md 补充局部规则
```

---

### 7. 其他小而实的改进

**优先级：低** ｜ **可按需逐个实施**

#### 7.1 transcript 解析独立模块化

pi-gui 的 `transcript.ts` 把执行轨迹解析做成独立可测模块。本项目的"执行过程"解析（`codex_trace.ts`、`claude_trace.ts`）已部分独立，可进一步抽出公共的 transcript 解析接口。

#### 7.2 会话标题自动生成

pi-gui 的 `thread-title-generator.ts` 独立处理会话标题生成。本项目可在 Provider 会话完成后自动生成标题，减少用户手动命名的负担。

#### 7.3 afterPack 打包瘦身

pi-gui 在 electron-builder 的 `afterPack` 阶段剪掉：
- 未用的 Electron locales（只保留 zh-CN 和 en-US）
- 跨架构的 node-pty 产物（x64/arm64 互不干扰）
- 内置 Git Bash 的文档

本项目打包体积优化可借鉴，特别是多架构 Windows 打包时的 node-pty 清理。

#### 7.4 vendor 目录模式

pi-gui 的 `pi-sdk-driver/src/vendor/` 存放上游 SDK 不满足需求时的本地定制版本，保持主代码升级路径清晰。本项目在 Claude SDK / Codex SDK 行为不符预期时可采用同样模式。

#### 7.5 electron-vite 共享包 watch 联动

pi-gui 的 dev 模式下共享 workspace 包保持 watch，renderer 编辑热更新、main/preload 改动触发 reload/restart，共享包改动自动被拾取。本项目实施第 1 条分层架构后，需确保 dev 模式下 driver 包改动能热加载。

---

## 优先级总览

| 编号 | 项目 | 优先级 | 预估工作量 | 依赖 |
|------|------|--------|-----------|------|
| 4 | Windows UTF-8 编码处理 | — | ✅ 已完成 | — |
| 6 | AGENTS.md 仓库指引 | — | ✅ 已完成 | 无 |
| 1 | 三层 Provider 分层架构 | 高 | 2-3 天 | 无 |
| 2 | Supervisor 进程管理 | 中 | 1-2 天 | 第 1 条 |
| 5 | Playwright 分层 E2E | — | ✅ 已完成 | 无 |
| 3 | 托管运行时环境 | 中 | 1-2 天 | 无 |
| 7 | 其他小改进 | 低 | 按需 | 各自独立 |

**建议顺序**：6（立刻做，成本极低）→ 1（架构基础）→ 2（依赖 1）→ 5（测试保障）→ 3（安装体验）→ 7（按需补充）
