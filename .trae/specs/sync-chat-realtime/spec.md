# 聊天实时同步 Spec

## Why
当前桌面端和移动端在 AI 会话中存在消息结构、执行过程、过程输出和最终结果显示不一致的问题。由于桌面端是执行方、移动端也可以作为发起方，两端必须共享同一套实时消息状态，避免一端只有过程、另一端只有结果。

## What Changes
- 统一桌面端和移动端的 AI 消息结构：同一条 assistant 消息同时包含执行过程 `segments` 和最终正文 `text`。
- 不管消息由桌面端还是移动端发起，执行过程、过程中的输出增量、最终回复都必须实时同步到两端。
- 桌面端作为执行方时，必须把本地产生的运行事件同时投递给桌面 renderer 和移动端。
- 移动端作为发起方时，桌面端必须实时创建或激活对应会话并展示运行过程和结果。
- 两端历史加载必须保持结构化消息，不得把 `segments + text` 降级成纯文本。
- 过滤内部调试状态，避免 `mobile sent message` 等内部事件出现在用户可见过程里。

## Impact
- Affected specs: AI 聊天会话、移动端同步、桌面端执行器、云端 WebSocket 协议、历史消息结构化存储
- Affected code:
  - `apps/desktop/src/main/sync.ts`
  - `apps/desktop/src/composables/useWorkspace.ts`
  - `apps/desktop/src/components/ChatMessageRow.vue`
  - `apps/desktop/src/components/ChatSegment.vue`
  - `apps/desktop/src/services/desktop.ts`
  - `apps/mobile/lib/state/workspace_controller.dart`
  - `apps/mobile/lib/pages/chat_page.dart`
  - `apps/mobile/lib/widgets/chat_segment_view.dart`
  - `apps/mobile/lib/models/workbench_models.dart`
  - `backend/internal/protocol/protocol.go`
  - WebSocket 转发与 AI history response 相关代码

## ADDED Requirements
### Requirement: 双端实时同步同一条 assistant 消息
系统 SHALL 在桌面端和移动端使用同一条 assistant 消息承载执行过程、过程输出和最终结果。

#### Scenario: 桌面端发起 AI 消息
- **WHEN** 用户在桌面端发送 AI 消息
- **THEN** 桌面端应实时显示执行过程、过程输出和最终结果
- **AND** 移动端应实时同步同一条 assistant 消息的执行过程、过程输出和最终结果

#### Scenario: 移动端发起 AI 消息
- **WHEN** 用户在移动端发送 AI 消息
- **THEN** 移动端应实时显示执行过程、过程输出和最终结果
- **AND** 桌面端应自动激活或创建对应会话视图，并实时显示同一条 assistant 消息的执行过程、过程输出和最终结果

### Requirement: 执行方事件必须双向投递
系统 SHALL 将桌面端执行方产生的 AI 运行事件同时投递给桌面 renderer 和移动端连接。

#### Scenario: 执行过程中产生 step 状态
- **WHEN** AI 执行器产生 `status`、`step-start` 或 `step-update` 事件
- **THEN** 桌面端和移动端都应收到并更新同一条 pending assistant 消息的 `segments`

#### Scenario: 执行过程中产生文本增量
- **WHEN** AI 执行器产生最终回复文本 delta
- **THEN** 桌面端和移动端都应实时累积到 assistant 消息的 `text`

#### Scenario: 执行完成
- **WHEN** AI 执行器产生 done 事件
- **THEN** 桌面端和移动端都应将 pending assistant 消息标记完成
- **AND** 保留执行过程 `segments`
- **AND** 保留最终正文 `text`

### Requirement: 结构化历史同步
系统 SHALL 在历史存储和历史同步中保留结构化 assistant 消息。

#### Scenario: 重新打开会话
- **WHEN** 用户在任一端重新打开已有 AI 会话
- **THEN** 历史消息应恢复执行过程 `segments` 和最终正文 `text`
- **AND** 不应只显示过程或只显示结果

### Requirement: 内部状态不可见
系统 SHALL 过滤内部同步状态，不向用户展示调试事件。

#### Scenario: 移动端发起消息
- **WHEN** 系统内部产生 `mobile sent message` 状态
- **THEN** 桌面端和移动端都不应把该状态显示为用户可见执行过程

## MODIFIED Requirements
### Requirement: 桌面端 assistant 消息渲染
桌面端 SHALL 在 assistant 消息存在 `segments` 和 `text` 时同时渲染两者，其中过程区域显示 `segments`，最终回复区域显示 `text`。

### Requirement: 移动端 assistant 消息渲染
移动端 SHALL 与桌面端保持一致的消息结构和显示顺序，其中过程区域在最终回复之前显示。

### Requirement: 移动端发起会话的桌面端激活
桌面端 SHALL 在收到移动端发起的 AI 输出事件时自动刷新会话、激活对应会话，并把实时事件挂载到 pending assistant 消息上。

## REMOVED Requirements
### Requirement: 纯文本 assistant 历史降级
**Reason**: 纯文本降级会丢失执行过程，导致一端只能显示结果或只能显示过程。
**Migration**: 历史同步和本地存储应优先使用结构化 `{ text, segments }` 格式；旧纯文本历史仍按普通正文显示。