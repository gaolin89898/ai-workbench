# 项目长期笔记

## ACP 兼容的 AI 编程 CLI（可零改动复用 acp.ts 对接）

以下 CLI 都支持 ACP（Agent Client Protocol，JSON-RPC over stdio），协议与已对接的 OpenCode/MiMo 一致，对接时只需在 `providers.ts` 的 `BUILTIN_PROVIDERS` 注册 + `acp.ts` 的 `PROVIDER_COMMANDS` 加命令映射：

| 工具 | 厂商 | 命令 | 国内可用 |
|------|------|------|---------|
| Qwen Code | 阿里通义 | `qwen acp` | 百炼可用 |
| Kimi CLI | 月之暗面 | `kimi acp` | 国产直连 |
| CodeBuddy CLI | 腾讯 | `codebuddy --acp` | 国产直连/iOA版 |
| Gemini CLI | Google | `gemini acp` | 需海外 API |

实测确认（2026-07-10）：OpenCode/MiMo 的 ACP 握手协议完全一致，session/new/set_config_option/session/prompt 方法通用。Qwen Code 是 Gemini-CLI 上游同步项目，Kimi CLI 明确支持 ACP IDE 集成。

## 需单独适配的 CLI

- **Aider**（开源 47k★）：`--json` 流式输出，Python 老牌，OpenAI 兼容，最易单独适配（参考 claude.ts stream-json 路径）
- **Goose**（Block 51k★）：MCP + session
- **Crush**（Charm 26k★）：LSP-aware 多模型
- **Amazon Q CLI**（AWS）：非交互模式
