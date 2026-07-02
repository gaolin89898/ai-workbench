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
  double? _progress;

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
                AppSectionTitle('移动端安装包',
                    subtitle: '从 GitHub Releases 下载最新 APK'),
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
                if (_progress != null) ...[
                  const SizedBox(height: AppSpacing.md),
                  LinearProgressIndicator(value: _progress),
                ],
                if (update != null) ...[
                  const SizedBox(height: 14),
                  _UpdateStatus(update: update),
                  if (update.available) ...[
                    const SizedBox(height: AppSpacing.md),
                    FilledButton.icon(
                      onPressed: _opening ? null : _installUpdate,
                      icon: const Icon(Icons.download),
                      label: Text(_opening ? '下载中' : '下载安装包'),
                    ),
                  ],
                ],
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            '当前版本：v${update?.currentVersion ?? MobileUpdateService.currentVersion}',
            style: const TextStyle(fontSize: 12, color: AppColors.muted),
          ),
        ],
      ),
    );
  }

  Future<void> _checkUpdate() async {
    setState(() {
      _checking = true;
      _progress = null;
      _status = '正在检查 GitHub Releases...';
    });
    try {
      final update = await _updates.check();
      if (!mounted) return;
      setState(() {
        _update = update;
        _status = update.available
            ? '发现移动端安装包 v${update.version ?? update.currentVersion}，可直接下载并安装。'
            : '当前已是最新版本 v${update.currentVersion}。';
      });
    } catch (error) {
      if (mounted) setState(() => _status = '检查更新失败：$error');
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _installUpdate() async {
    final update = _update;
    if (update == null) return;
    setState(() {
      _opening = true;
      _progress = null;
      _status = '正在下载 APK...';
    });
    try {
      await _updates.downloadAndInstall(
        update,
        onProgress: (received, total) {
          if (!mounted || total == null || total <= 0) return;
          setState(() {
            _progress = received / total;
            _status = '正在下载 APK：${(_progress! * 100).toStringAsFixed(0)}%';
          });
        },
      );
      if (mounted) {
        setState(() {
          _progress = null;
          _status = '已打开系统安装器，请按提示安装。';
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _progress = null;
          _status = '下载安装失败：$error';
        });
      }
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
            icon: Icons.download,
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
                Text(
                  '移动端 v${update.version ?? update.currentVersion}',
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    color: AppColors.ink,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '来源：${update.source}，将直接下载 APK 并调用系统安装器。',
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
