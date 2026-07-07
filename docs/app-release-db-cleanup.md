# 版本发布数据库清理

本文档记录如何修复后端 `app_releases` 表中旧数据或半成品数据导致的客户端更新下载失败问题。

## 问题原因

客户端检查更新时会请求后端：

```text
GET /app/releases?platform=desktop|mobile&currentVersion=<version>&os=win32|linux
```

后端处理顺序是：

1. 先查数据库 `app_releases`。
2. 如果对应平台存在 `enabled = TRUE` 的记录，直接返回数据库记录。
3. 只有数据库没有启用记录时，才会回退到 GitHub Releases 自动识别最新版本。

因此，只要数据库里存在旧的或不完整的启用记录，即使 GitHub Release 上已经上传了正确安装包，客户端仍然会拿到数据库里的旧下载地址或空下载地址。

常见触发场景：

- 在 GitHub Release 的桌面端 Windows/Linux 安装包还没上传完成时，就在后台“版本发布”页面导入或保存了新版本。
- `latest_version` 已经改成新版本，但 `windows_download_url`、`linux_download_url` 或 `download_url` 仍指向旧版本。
- 数据库记录已启用，但当前系统需要的下载 URL 为空。

## 连接生产数据库

在生产部署目录，也就是包含 `docker-compose.prod.yml` 的目录下执行：

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U remote_term -d remote_term
```

先查看当前版本发布记录：

```sql
SELECT
  platform,
  latest_version,
  min_supported_version,
  download_url,
  windows_download_url,
  linux_download_url,
  release_url,
  enabled,
  source,
  updated_at
FROM app_releases
ORDER BY platform;
```

## 快速恢复：禁用数据库覆盖

如果 GitHub Releases 上已经有正确资产，并且希望后端重新使用 GitHub 作为版本来源，可以直接禁用数据库发布记录：

```sql
UPDATE app_releases
SET
  enabled = FALSE,
  updated_at = NOW()
WHERE platform IN ('desktop', 'mobile');
```

禁用后，如果某个平台没有启用的数据库记录，`/app/releases` 会自动回退到 GitHub Releases。

## 修复 v0.1.70 桌面端发布记录

如果希望继续由后台数据库手动管理桌面端版本，执行以下 SQL：

```sql
INSERT INTO app_releases (
  platform,
  latest_version,
  min_supported_version,
  download_url,
  windows_download_url,
  linux_download_url,
  release_url,
  release_notes,
  force,
  enabled,
  source,
  updated_at
)
VALUES (
  'desktop',
  '0.1.70',
  NULL,
  NULL,
  'https://github.com/gaolin89898/ai-workbench/releases/download/v0.1.70/AI-Workbench-Setup-0.1.70.exe',
  'https://github.com/gaolin89898/ai-workbench/releases/download/v0.1.70/AI-Workbench-0.1.70-x86_64.AppImage',
  'https://github.com/gaolin89898/ai-workbench/releases/tag/v0.1.70',
  '修复桌面端聊天会话隔离和运行中会话切换问题。',
  FALSE,
  TRUE,
  'manual',
  NOW()
)
ON CONFLICT (platform) DO UPDATE SET
  latest_version = EXCLUDED.latest_version,
  min_supported_version = EXCLUDED.min_supported_version,
  download_url = EXCLUDED.download_url,
  windows_download_url = EXCLUDED.windows_download_url,
  linux_download_url = EXCLUDED.linux_download_url,
  release_url = EXCLUDED.release_url,
  release_notes = EXCLUDED.release_notes,
  force = EXCLUDED.force,
  enabled = EXCLUDED.enabled,
  source = EXCLUDED.source,
  updated_at = NOW();
```

## 修复 v0.1.70 移动端发布记录

如果移动端也需要由后台数据库手动管理，执行以下 SQL：

```sql
INSERT INTO app_releases (
  platform,
  latest_version,
  min_supported_version,
  download_url,
  windows_download_url,
  linux_download_url,
  release_url,
  release_notes,
  force,
  enabled,
  source,
  updated_at
)
VALUES (
  'mobile',
  '0.1.70',
  NULL,
  'https://github.com/gaolin89898/ai-workbench/releases/download/v0.1.70/ai-workbench-mobile-0.1.70.apk',
  NULL,
  NULL,
  'https://github.com/gaolin89898/ai-workbench/releases/tag/v0.1.70',
  '同步 v0.1.70 移动端安装包。',
  FALSE,
  TRUE,
  'manual',
  NOW()
)
ON CONFLICT (platform) DO UPDATE SET
  latest_version = EXCLUDED.latest_version,
  min_supported_version = EXCLUDED.min_supported_version,
  download_url = EXCLUDED.download_url,
  windows_download_url = EXCLUDED.windows_download_url,
  linux_download_url = EXCLUDED.linux_download_url,
  release_url = EXCLUDED.release_url,
  release_notes = EXCLUDED.release_notes,
  force = EXCLUDED.force,
  enabled = EXCLUDED.enabled,
  source = EXCLUDED.source,
  updated_at = NOW();
```

## 后续版本通用模板

执行前替换所有 `<version>`、URL 和发布说明：

```sql
INSERT INTO app_releases (
  platform,
  latest_version,
  min_supported_version,
  download_url,
  windows_download_url,
  linux_download_url,
  release_url,
  release_notes,
  force,
  enabled,
  source,
  updated_at
)
VALUES (
  'desktop',
  '<version>',
  NULL,
  NULL,
  'https://github.com/gaolin89898/ai-workbench/releases/download/v<version>/AI-Workbench-Setup-<version>.exe',
  'https://github.com/gaolin89898/ai-workbench/releases/download/v<version>/AI-Workbench-<version>-x86_64.AppImage',
  'https://github.com/gaolin89898/ai-workbench/releases/tag/v<version>',
  '<release notes>',
  FALSE,
  TRUE,
  'manual',
  NOW()
)
ON CONFLICT (platform) DO UPDATE SET
  latest_version = EXCLUDED.latest_version,
  min_supported_version = EXCLUDED.min_supported_version,
  download_url = EXCLUDED.download_url,
  windows_download_url = EXCLUDED.windows_download_url,
  linux_download_url = EXCLUDED.linux_download_url,
  release_url = EXCLUDED.release_url,
  release_notes = EXCLUDED.release_notes,
  force = EXCLUDED.force,
  enabled = EXCLUDED.enabled,
  source = EXCLUDED.source,
  updated_at = NOW();
```

## 清理后验证

在能访问后端的机器上执行：

```bash
curl -fsS 'https://<server>/app/releases?platform=desktop&currentVersion=0.1.69&os=win32'
curl -fsS 'https://<server>/app/releases?platform=desktop&currentVersion=0.1.69&os=linux'
curl -fsS 'https://<server>/app/releases?platform=mobile&currentVersion=0.1.69'
```

Windows 桌面端响应里应包含：

```json
{
  "latestVersion": "0.1.70",
  "available": true,
  "downloadUrl": "https://github.com/gaolin89898/ai-workbench/releases/download/v0.1.70/AI-Workbench-Setup-0.1.70.exe",
  "windowsDownloadUrl": "https://github.com/gaolin89898/ai-workbench/releases/download/v0.1.70/AI-Workbench-Setup-0.1.70.exe"
}
```

Linux 桌面端响应里的 `downloadUrl` 应为：

```text
https://github.com/gaolin89898/ai-workbench/releases/download/v0.1.70/AI-Workbench-0.1.70-x86_64.AppImage
```

## 运维注意事项

使用后台“导入 GitHub”按钮前，先确认桌面端 release workflow 已完成，并且 GitHub Release 中已经包含 Windows 和 Linux 桌面端安装包。过早保存会把不完整记录写入数据库，导致后端不再走 GitHub 兜底路径。
