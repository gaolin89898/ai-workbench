# 桌面端自动更新

桌面端使用 electron-updater 从 GitHub Releases 拉取更新。

## 更新来源

electron-updater 会读取对应 Release 的 `latest.yml` 元数据，并下载其中的安装包：

```text
https://github.com/gaolin89898/ai-workbench/releases/latest/download/latest.yml
```

`latest.yml`、deb 和 AppImage 由 `.github/workflows/release-desktop.yml` 在推送版本标签时构建并上传。

> 注意：`latest.yml` 是 electron-builder 自动生成的元数据文件，与 Tauri 的 `latest.json` 不同，两者不通用。

## 配置

发布目标已在 [apps/desktop/electron-builder.yml](../apps/desktop/electron-builder.yml) 中配置：

```yaml
publish:
  provider: github
  owner: gaolin89898
  repo: ai-workbench
  releaseType: release
```

## GitHub Secrets

CI 中的 `GH_TOKEN` 直接使用 GitHub Actions 自动提供的 `GITHUB_TOKEN`，无需额外配置即可创建 Release 并上传资产。

代码签名说明：

- Linux 平台 electron-builder 默认不强制代码签名，可直接发布。
- 如需对 Linux 包进行签名，参考 [electron-builder 代码签名文档](https://www.electron.build/code-signing) 配置对应证书和 Secret。

## 发版流程

1. 同步版本号到 `apps/desktop/package.json`：

   ```json
   {
     "version": "0.1.x"
   }
   ```

2. 提交并推送：

   ```bash
   git add apps/desktop/package.json
   git commit -m "Release v0.1.x"
   git push
   ```

3. 推送 tag 触发 GitHub Release：

   ```bash
   git tag v0.1.x
   git push origin v0.1.x
   ```

4. GitHub Actions 会构建 Electron 应用、创建 Release，并上传 deb、AppImage 和 `latest.yml`。

## One-command desktop + mobile release

Run this from the repository root to publish desktop Windows/Linux and mobile Android in one step:

```powershell
.\scripts\release-all.ps1 -Version 0.1.x
```

The script updates `apps/desktop/package.json` and `apps/mobile/pubspec.yaml`, commits the release version, pushes `main`, then pushes both tags:

- `v0.1.x` for desktop Windows/Linux
- `mobile-v0.1.x` for Android APK

Mobile release still requires valid Android signing secrets in GitHub Actions.

5. 旧版本桌面端在“设置 -> 应用更新”点击检查更新后，electron-updater 拉取 `latest.yml`，下载安装包并提示重启安装。
