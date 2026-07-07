# 软件更新和版本发布

AI 工作台的软件更新采用“服务端版本策略优先，GitHub Releases 兜底”的方式。

这套机制覆盖：

- 桌面端 Electron 应用更新。
- 移动端 APK 更新提示。
- 后台管理员手动发布版本策略。
- 最低可用版本，也就是不兼容老版本时提示必须更新。
- 在线客户端 WebSocket 更新通知。

客户端不会静默安装更新。用户点击更新后才会下载或打开安装包；桌面端如果有 AI 会话正在运行，会提示先停止当前会话再更新。

## 更新来源

客户端检查更新时，优先请求当前登录服务器：

```text
GET /app/releases?platform=desktop|mobile&currentVersion=<currentVersion>
```

服务端处理逻辑：

1. 后台如果启用了对应平台的版本配置，直接使用后台配置。
2. 如果后台没有启用配置，再从 GitHub Releases 读取最新版本作为兜底。
3. 如果当前版本低于 `latestVersion`，返回 `available=true`。
4. 如果当前版本低于 `minSupportedVersion`，返回 `required=true`。
5. 如果后台启用了 `force`，并且当前版本落后，也返回 `required=true`。

返回示例：

```json
{
  "platform": "desktop",
  "currentVersion": "0.1.68",
  "latestVersion": "0.1.69",
  "minSupportedVersion": "0.1.69",
  "available": true,
  "required": true,
  "force": false,
  "downloadUrl": null,
  "releaseUrl": "https://github.com/gaolin89898/ai-workbench/releases/tag/v0.1.69",
  "releaseNotes": "修复登录和更新提示",
  "source": "manual"
}
```

字段含义：

- `available`：发现新版本。
- `required`：当前版本已经不兼容或被后台标记为必须更新。
- `minSupportedVersion`：最低可用版本，低于该版本时客户端提示必须更新。
- `force`：强制更新提示；当前版本落后时会被视为必须更新。
- `downloadUrl`：移动端 APK 或安装包下载地址。
- `releaseUrl`：Release 页面地址。
- `releaseNotes`：展示给用户看的更新说明。
- `source`：`manual` 表示后台配置，`github` 表示 GitHub Releases 兜底。

## 后台版本发布

用户管理后台有“版本发布”页面。管理员可以分别配置：

- 桌面端最新版本。
- 移动端最新版本。
- 最低可用版本。
- 下载地址。
- Release 页面。
- 更新说明。
- 是否启用配置。
- 是否强制更新提示。

保存后，服务端会向在线客户端推送：

```text
app.update.available
```

桌面端和移动端收到后会在更新入口提示用户。

## 不兼容老版本

如果新版本修改了协议、登录流程、数据库结构或移动端交互，老版本不应该继续使用时，在后台设置 `最低可用版本`。

例如：

```text
latestVersion = 0.1.70
minSupportedVersion = 0.1.70
```

当前版本为 `0.1.69` 的客户端会收到：

```json
{
  "available": true,
  "required": true
}
```

客户端会提示“当前版本过低，需要更新后继续使用”。

注意：已经发布出去、完全没有这套更新通知逻辑的更老客户端，无法被新协议主动弹出新的强制更新 UI。它们只能依赖旧版本已有的检查更新入口，或通过外部渠道通知用户更新。

## 桌面端 GitHub Releases 兜底

桌面端仍保留 electron-updater 从 GitHub Releases 拉取更新的能力。

electron-updater 会读取对应 Release 的 `latest.yml` 元数据，并下载其中的安装包：

```text
https://github.com/gaolin89898/ai-workbench/releases/latest/download/latest.yml
```

`latest.yml`、deb、AppImage 和 Windows 安装包由 GitHub Actions 在推送版本标签时构建并上传。

> 注意：`latest.yml` 是 electron-builder 自动生成的元数据文件，与 Tauri 的 `latest.json` 不同，两者不通用。

发布目标配置在 [apps/desktop/electron-builder.yml](../apps/desktop/electron-builder.yml)：

```yaml
publish:
  provider: github
  owner: gaolin89898
  repo: ai-workbench
  releaseType: release
```

CI 中的 `GH_TOKEN` 直接使用 GitHub Actions 自动提供的 `GITHUB_TOKEN`，无需额外配置即可创建 Release 并上传资产。

## 发版流程

1. 同步版本号到桌面端和移动端。

   桌面端：

   ```json
   {
     "version": "0.1.x"
   }
   ```

   移动端：

   ```yaml
   version: 0.1.x+x
   ```

2. 提交并推送：

   ```bash
   git add apps/desktop/package.json apps/mobile/pubspec.yaml
   git commit -m "Release v0.1.x"
   git push
   ```

3. 推送 tag 触发 GitHub Release：

   ```bash
   git tag v0.1.x
   git push origin v0.1.x
   ```

4. GitHub Actions 会构建桌面端安装包和移动端 APK，并上传到 Release。

5. 在用户管理后台“版本发布”页面配置新版本。

6. 保存后，在线客户端会收到更新提示；不在线客户端下次检查更新时也会从服务端拿到同一份版本策略。

## One-command desktop + mobile release

从仓库根目录运行：

```powershell
.\scripts\release-all.ps1 -Version 0.1.x
```

脚本会更新 `apps/desktop/package.json` 和 `apps/mobile/pubspec.yaml`，提交版本号，推送 `main`，再推送共享标签：

- `v0.1.x`：桌面端 Windows/Linux 和 Android APK。

移动端 Release 仍需要 GitHub Actions 中配置有效的 Android 签名密钥。
