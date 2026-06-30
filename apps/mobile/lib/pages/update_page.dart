import 'package:flutter/material.dart';

import '../services/update_service.dart';
import '../widgets/app_theme.dart';

class UpdatePage extends StatefulWidget {
  const UpdatePage({super.key});

  @override
  State<UpdatePage> createState() => _UpdatePageState();
}

class _UpdatePageState extends State<UpdatePage> {
  final _updates = const MobileUpdateService();
  MobileUpdateInfo? _update;
  String _status = '尚未检查更新。';
  bool _checking = false;
  bool _opening = false;

  @override
  Widget build(BuildContext context) {
    final update = _update;
    return Scaffold(
      appBar: AppBar(title: const Text('应用更新')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.lg,
          AppSpacing.lg,
          AppSpacing.lg,
          100,
        ),
        children: [
          AppCard(
            borderRadius: AppRadius.x2l,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AppSectionTitle('移动端安装包', subtitle: '从 OpenList 下载最新 APK'),
                const SizedBox(height: AppSpacing.lg),
                FilledButton.icon(
                  onPressed: _checking ? null : _checkUpdate,
                  icon: const Icon(Icons.system_update_alt),
                  label: Text(_checking ? '检查中' : '检查更新'),
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          AppCard(
            borderRadius: AppRadius.x2l,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  '更新状态',
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                    color: AppColors.ink,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  _status,
                  style: const TextStyle(
                    fontSize: 13,
                    color: AppColors.muted,
                    height: 1.55,
                  ),
                ),
                if (update != null) ...[
                  const SizedBox(height: 14),
                  _UpdateStatus(update: update),
                  const SizedBox(height: AppSpacing.md),
                  FilledButton.icon(
                    onPressed: _opening ? null : _openUpdate,
                    icon: const Icon(Icons.open_in_new),
                    label: Text(_opening ? '打开中' : '打开下载目录'),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            '当前版本：v${update?.currentVersion ?? '-'}',
            style: const TextStyle(fontSize: 12, color: AppColors.muted),
          ),
        ],
      ),
    );
  }

  Future<void> _checkUpdate() async {
    setState(() {
      _checking = true;
      _status = '正在检查 OpenList 下载目录...';
    });
    try {
      final update = await _updates.check();
      if (!mounted) return;
      setState(() {
        _update = update;
        _status = '移动端安装包已迁移到 OpenList，请打开下载目录获取最新 APK。';
      });
    } catch (error) {
      if (mounted) setState(() => _status = '检查更新失败：$error');
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _openUpdate() async {
    final update = _update;
    if (update == null) return;
    setState(() {
      _opening = true;
      _status = '正在打开 OpenList 下载目录...';
    });
    try {
      await _updates.openDownload(update);
      if (mounted) setState(() => _status = '已打开下载目录，请选择最新 APK 安装。');
    } catch (error) {
      if (mounted) setState(() => _status = '打开下载目录失败：$error');
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }
}

class _UpdateStatus extends StatelessWidget {
  const _UpdateStatus({required this.update});

  final MobileUpdateInfo update;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      background: AppColors.surfaceMuted,
      borderColor: AppColors.border,
      shadow: const [],
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppIconBox(
            icon: Icons.folder_open,
            size: 26,
            iconSize: 16,
            borderRadius: AppRadius.lg,
            background: AppColors.successSoft,
            foreground: AppColors.successDeep,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'OpenList 下载目录',
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                    color: AppColors.ink,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '当前版本 v${update.currentVersion}，来源：${update.source}',
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 12,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
