# Tasks
- [x] Task 1: 统一实时事件协议和转发链路。
  - [x] SubTask 1.1: 确认后端 WebSocket 协议支持 `segments` 和结构化 history content。
  - [x] SubTask 1.2: 确认桌面执行方产生的 `status`、`step-start`、`step-update`、`delta`、`done` 同时发给桌面 renderer 和移动端。
  - [x] SubTask 1.3: 过滤 `mobile sent message` 等内部同步状态。

- [x] Task 2: 修复桌面端实时消息状态。
  - [x] SubTask 2.1: 移动端发起消息时，桌面端自动刷新并激活对应 AI 会话。
  - [x] SubTask 2.2: 桌面端为移动端发起的运行创建 pending assistant 消息。
  - [x] SubTask 2.3: 桌面端在 pending 期间不允许历史刷新覆盖实时过程。
  - [x] SubTask 2.4: 桌面端 assistant 消息同时渲染过程 `segments` 和最终正文 `text`。

- [x] Task 3: 修复移动端实时消息状态。
  - [x] SubTask 3.1: 移动端实时合并同一条 pending assistant 消息的 `segments` 和 `text`。
  - [x] SubTask 3.2: 移动端按 `stepId` 合并过程段，避免重复堆叠同一过程。
  - [x] SubTask 3.3: 移动端 done 时保留 pending 消息已有的 `segments` 和 `text`。
  - [x] SubTask 3.4: 移动端历史加载恢复结构化 `{ text, segments }`。

- [x] Task 4: 对齐桌面端和移动端消息渲染结构。
  - [x] SubTask 4.1: 桌面端显示顺序为执行过程在上、最终结果在下。
  - [x] SubTask 4.2: 移动端显示顺序为执行过程在上、最终结果在下。
  - [x] SubTask 4.3: 两端都不应出现只有过程或只有最终结果的 assistant 消息。

- [x] Task 5: 验证同步行为。
  - [x] SubTask 5.1: 验证桌面端发起时，两端实时显示过程、过程输出和最终结果。
  - [x] SubTask 5.2: 验证移动端发起时，两端实时显示过程、过程输出和最终结果。
  - [x] SubTask 5.3: 验证重新打开历史会话时，两端恢复过程和最终结果。
  - [x] SubTask 5.4: 运行可用的桌面端构建、后端测试和移动端静态检查。

# Task Dependencies
- Task 2 depends on Task 1.
- Task 3 depends on Task 1.
- Task 4 depends on Task 2 and Task 3.
- Task 5 depends on Task 1, Task 2, Task 3, and Task 4.