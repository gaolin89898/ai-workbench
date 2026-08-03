# Codex 功能接入路线图

更新日期：2026-07-30

## 目标

本文档整理 Codex 当前可用于 AI Workbench 的能力，并根据项目现状标记缺口、工作量和建议优先级，供后续选择接入范围。

## 已有能力

以下能力已经接入，不再列为待开发项：

- 通过 Codex app-server 建立会话并流式接收事件。
- `thread/start` 和 `thread/resume`。
- `turn/start`。
- 动态调用 `model/list` 获取可用模型。
- 根据模型返回值显示支持的推理强度。
- 支持 `low`、`medium`、`high`、`xhigh`、`max` 和 `ultra` 推理强度。
- 支持默认模式和计划模式。
- 支持图片输入。
- 支持解析 `mcpToolCall` 和 `dynamicToolCall`，展示真实工具名、参数、进度、成功/失败、错误与耗时。
- 支持通过 `turn/steer` 在运行中追加当前轮指令。
- 支持按会话维护下一轮消息队列，可编辑、排序、删除、手动发送并在正常完成后自动续发。
- 支持通过 `turn/interrupt` 原生停止当前 Turn；只有协议请求失败时才使用进程信号兜底。
- 支持 Goal Mode 的目标设置和展示。
- 支持基础审批模式和自动审批审查。
- 支持本地会话归档、移动端同步和独立终端。
- 支持文档、代码、图片和 Markdown 侧栏预览。
- 支持 Codex 原生 Thread 归档、恢复和永久删除，并与本地会话状态同步。
- 支持读取、设置、清除、暂停和恢复 Goal，展示目标状态、Token 用量和运行时间。
- 支持通过 `thread/compact/start` 手动压缩当前会话上下文。
- 支持将 PDF、Office 文档、Markdown 和代码文件作为 `mention` 附件发送给 Codex。

> GPT-5.6 Sol、Terra、Luna 等模型会由 `model/list` 动态返回。模型选择和推理强度选择已经具备，不需要重复开发。Power、Powerful 和 Efficient 主要属于官方客户端的快捷预设 UI。

## 功能清单

| 编号 | 功能 | 当前状态 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | 工具调用名称与状态 | 已接入：展示真实工具名、参数、进度、成功/失败、错误和耗时 | 已完成 | 已完成 |
| 2 | 运行中追加指令 | 已接入：使用 `turn/steer` 追加到当前 Turn | 已完成 | 已完成 |
| 3 | 后续消息排队 | 已接入：支持编辑、排序、删除、手动发送和正常完成后自动续发 | 已完成 | 已完成 |
| 4 | 原生停止当前 Turn | 已接入：优先使用 `turn/interrupt`，协议失败时才降级到进程信号 | 已完成 | 已完成 |
| 5 | Codex 原生会话中心 | 已接入：支持列表、项目范围、搜索、归档筛选、分页、详情、改名和实时状态 | 已完成 | 已完成 |
| 6 | 全局 MCP 管理中心 | 已接入独立页面：展示服务器、工具、资源、资源模板、认证、OAuth、重载和启动错误 | 已完成 | 已完成 |
| 7 | Codex 配置中心 | 已接入：支持有效配置、来源分层、单项/批量写入和功能开关 | 已完成 | 已完成 |
| 8 | 会话分叉 | 已接入 `thread/fork`：会话管理（资源中心 → 会话管理）本地会话操作列新增"分叉"，复制新 thread，原会话不变 | 已完成 | 已完成 |
| 9 | Side Chat | 缺不影响主上下文的临时侧聊 | 中 | P1 |
| 10 | 原生归档与删除 | 已接入：支持原生归档、恢复和永久删除，本地会话与 Codex Thread 同步更新 | 已完成 | 已完成 |
| 11 | Goal Mode 完整控制 | 已接入：支持读取、设置、清除、暂停、恢复、状态及用量展示 | 已完成 | 已完成 |
| 12 | 上下文压缩 | 已接入：支持对空闲 Codex Thread 发起 `thread/compact/start` 并展示执行反馈 | 已完成 | 已完成 |
| 13 | 权限配置与动态授权 | 已接入：保留 Codex 原生四项权限菜单，后台读取权限档位并遵循管理员禁用状态；支持展示文件读写和网络权限申请，并可按本轮或本会话授权 | 已完成 | 已完成 |
| 14 | Skills 管理 | 已接入：支持发现、查看、启停、额外目录和实时刷新（SkillsManagementPanel.vue、codex_skills.ts） | 已完成 | 已完成 |
| 15 | Hooks 管理 | 已接入：资源中心新增 Hooks tab（hooks/list），展示事件名、类型、启用状态、信任状态、来源路径、超时、命令与加载错误/警告，支持搜索与事件筛选；执行状态见 statusMessage。启停/信任修改走配置中心（config.toml hooks 段） | 已完成 | 已完成 |
| 16 | Claude Code 配置迁移 | 已接入：设置 → 导入迁移。扫描 `~/.claude/`（CLAUDE_CONFIG_DIR 可覆盖），展示模型/权限/MCP/Skills/命令/历史统计；MCP 服务器一键迁移到 Codex（mcp_servers 配置）；严格过滤 token/key/secret 等凭证，绝不读取或展示 | 已完成 | 已完成 |
| 17 | 原生代码审查 | 已接入：`review/start`（uncommittedChanges / baseBranch / commit / custom 四种 target，inline/detached delivery），审查进度与结果通过 `enteredReviewMode` / `exitedReviewMode` item 实时同步到执行过程 | 已完成 | 已完成 |
| 18 | 文件附件发送 | 已接入：图片使用原生 image 输入，PDF、Office、Markdown 和代码使用本地 `mention` 附件输入 | 已完成 | 已完成 |
| 19 | Codex 独立沙盒终端 | 不采用：与现有本机终端功能重复，不展示聊天任务运行步骤，已移除 `command/exec` 接入 | 不做 | 已取消 |
| 20 | Fast 服务档位 | 已接入：按模型动态展示服务档位，支持默认/Fast 等档位选择、偏好保存、桌面与移动端同步并传入 `turn/start` | 已完成 | 已完成 |
| 21 | Subagents 任务树 | 缺父子代理、并行状态、进度和结果展示 | 大 | P2 |
| 22 | Ultra 并行模式 UI | 协议类型已有，但缺多代理执行视图 | 大 | P2 |
| 23 | Plugins 与市场 | 未接入；app-server 的插件安装接口仍标注为开发中 | 大 | 暂缓 |
| 24 | 定时任务 | 缺定时、事件触发、监控、运行历史和通知 | 大 | P2 |
| 25 | Git Worktree 任务隔离 | 缺创建、切换、清理和任务迁移 | 大 | P2 |
| 26 | Browser / Chrome / CDP | 缺页面预览、交互、截图、控制台和网络调试 | 很大 | P2 |
| 27 | Computer Use | 缺 Windows/macOS 桌面应用控制 | 很大 | P2 |
| 28 | Remote / SSH 主机 | 缺远程主机项目和远程 app-server 管理 | 很大 | P2 |
| 29 | 手机远程接管与任务迁移 | 已有自建同步，缺主机配对、审批和 Git 状态迁移 | 很大 | P2 |
| 30 | 多仓库项目 | 当前任务主要绑定单个项目路径 | 大 | P2 |

## 推荐实施顺序

### 第一阶段：完善核心交互

1. 已完成：解析 `mcpToolCall`，显示真实工具名、运行中、成功、失败和耗时。
2. 已完成：接入 `turn/steer` 和后续消息排队。
3. 已完成：使用 `turn/interrupt` 只停止当前 Turn，不直接终止 app-server。
4. 已完成：接入 Codex 原生会话列表、读取、搜索、命名和状态。
5. 已完成：建立独立的全局 MCP 管理中心。

### 第二阶段：完善会话与扩展管理

1. 原生归档和删除已完成；会话分叉、Side Chat 待接入。
2. Goal Mode 完整控制和上下文压缩已完成。
3. Codex 配置中心、权限配置和 Skills 管理已完成；Hooks 管理界面待接入。
4. 接入 Claude Code 配置迁移。
5. 文件附件发送已完成；原生代码审查已接入（review/start + 审查模式状态同步，行内评论待产品化）。

### 第三阶段：高级代理能力（部分已实现）

1. Pipeline 编排和 Chatroom 多角色协作模式已接入（desktop v0.2.x）。
2. 接入 Subagents 任务树和 Ultra 并行执行视图。
3. 增加定时任务和 Git Worktree 隔离。
4. 评估 Browser、Chrome、CDP 和 Computer Use。
5. 评估 Remote、SSH、多仓库项目和跨设备任务迁移。

## 接入注意事项

- Codex app-server 本身仍在快速迭代，应使用当前安装版本生成的 TypeScript 或 JSON Schema，避免手写固定协议类型。
- WebSocket transport 仍为实验能力；本地桌面进程优先继续使用 stdio。
- `plugin/list`、`plugin/install`、`plugin/uninstall` 等 app-server 接口仍标注为开发中，不建议作为近期生产功能。
- `permissionProfile/list`、部分后台终端和协作模式接口仍属于 Beta 或实验能力，应提供版本检测与降级逻辑。
- MCP 状态应区分服务器启动、认证、工具调用、资源读取和 OAuth 流程，不能继续统一显示为 `mcpToolCall`。
- 原生 Thread 与当前本地数据库会话需要建立稳定映射，避免出现重复会话或归档状态不一致。

## 官方参考

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex 最新功能](https://learn.chatgpt.com/docs/whats-new)
- [Codex 模型](https://learn.chatgpt.com/docs/models)
- [Codex 开发者命令](https://learn.chatgpt.com/docs/developer-commands)
- [Scheduled Tasks](https://learn.chatgpt.com/docs/automations)
- [Browser](https://learn.chatgpt.com/docs/browser)
- [Remote Connections](https://learn.chatgpt.com/docs/remote-connections)
