# 桌面端自动更新

桌面端使用 Tauri updater 从 GitHub Releases 拉取更新。

## 更新来源

应用会读取：

```text
https://github.com/gaolin89898/ai-workbench/releases/latest/download/latest.json
```

`latest.json` 和安装包由 `.github/workflows/release-desktop.yml` 在推送版本标签时生成。

## GitHub Secrets

发布前需要在 GitHub 仓库 Settings -> Secrets and variables -> Actions 中配置：

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

当前生成的私钥在本机：

```text
/home/gl/.ai-workbench-release/tauri-update.key
```

将该文件内容完整复制到 `TAURI_SIGNING_PRIVATE_KEY`。

当前私钥没有密码，所以 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可以留空或不配置。

注意：私钥丢失后，旧版本应用将无法验证新更新包，需要重新发安装包让用户手动安装。

## 发版流程

1. 同步版本号：

```text
apps/desktop/package.json
apps/desktop/src-tauri/Cargo.toml
apps/desktop/src-tauri/tauri.conf.json
```

2. 提交并推送：

```bash
git add .
git commit -m "Release v0.1.1"
git push github main
```

3. 推送 tag 触发 GitHub Release：

```bash
git tag v0.1.1
git push github v0.1.1
```

4. GitHub Actions 会构建桌面端、创建 Release，并上传安装包和 `latest.json`。

5. 旧版本桌面端在“设置 -> 应用更新”点击检查更新后，会下载签名包并重启安装。
