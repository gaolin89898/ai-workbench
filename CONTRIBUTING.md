# 贡献指南

感谢你对 AI 工作台项目的关注！本文档将帮助你了解如何参与贡献。

## 报告问题

如果你发现了 bug 或有功能建议，请通过 [GitHub Issues](https://github.com/gaolin89898/ai-workbench/issues) 提交。

### Bug 报告

请使用 Bug Report 模板，并包含以下信息：

- 问题描述
- 复现步骤
- 期望行为
- 实际行为
- 环境信息（操作系统、Node.js 版本等）
- 相关日志或截图

### 功能建议

请使用 Feature Request 模板，描述你希望添加的功能和使用场景。

## 提交代码

### 1. Fork 并克隆仓库

```bash
git clone https://github.com/<你的用户名>/ai-workbench.git
cd ai-workbench
git remote add upstream https://github.com/gaolin89898/ai-workbench.git
```

### 2. 创建分支

```bash
git checkout -b feature/你的功能名
```

分支命名建议：
- `feature/xxx` - 新功能
- `fix/xxx` - Bug 修复
- `docs/xxx` - 文档更新
- `refactor/xxx` - 代码重构

### 3. 开发环境

项目包含多个子项目，请根据你要修改的部分搭建对应环境：

**后端（Go）**
```bash
docker compose up -d postgres
cd backend
go run ./cmd/server
```

**桌面端（Electron + Vue）**
```bash
cd apps/desktop
pnpm install
pnpm dev
```

**移动端（Flutter）**
```bash
cd apps/mobile
flutter pub get
flutter run
```

**管理后台（Vue）**
```bash
cd user-admin-system
pnpm install
pnpm dev
```

### 4. 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <description>

[optional body]
```

类型（type）：
- `feat` - 新功能
- `fix` - Bug 修复
- `docs` - 文档
- `style` - 代码格式（不影响逻辑）
- `refactor` - 重构
- `test` - 测试
- `chore` - 构建/工具

示例：
```
feat(mobile): add codex approval dialog
fix(desktop): prevent duplicate session creation
docs: update README quick start section
```

### 5. 提交 PR

```bash
git push origin feature/你的功能名
```

然后在 GitHub 上创建 Pull Request，填写 PR 模板中的内容。

## 代码规范

- 后端：遵循 Go 标准规范，使用 `gofmt` 格式化
- 桌面端/管理后台：遵循 ESLint 规则
- 移动端：遵循 Flutter 官方规范，使用 `flutter analyze` 检查

## 行为准则

请阅读并遵守我们的 [行为准则](CODE_OF_CONDUCT.md)。

## 有问题？

如有疑问，欢迎在 [GitHub Discussions](https://github.com/gaolin89898/ai-workbench/discussions) 中提问。
