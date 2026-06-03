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
        padding: const EdgeInsets.all(16),
        children: [
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('移动端更新',
                    style:
                        TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
                const SizedBox(height: 6),
                const Text(
                  '优先从 OpenList 检查移动端 APK，失败时自动回退到 GitHub Releases。下载后会交给系统浏览器和安装器处理。',
                  style: TextStyle(color: AppColors.muted, height: 1.45),
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: _checking ? null : _checkUpdate,
                  icon: const Icon(Icons.system_update_alt_outlined),
                  label: Text(_checking ? '检查中' : '检查更新'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('更新状态',
                    style: TextStyle(fontWeight: FontWeight.w900)),
                const SizedBox(height: 8),
                Text(_status,
                    style:
                        const TextStyle(color: AppColors.muted, height: 1.45)),
                if (update != null) ...[
                  const SizedBox(height: 14),
                  _UpdateStatus(update: update),
                  if (update.available) ...[
                    const SizedBox(height: 12),
                    FilledButton.icon(
                      onPressed: _opening ? null : _openUpdate,
                      icon: const Icon(Icons.download_outlined),
                      label: Text(_opening ? '打开中' : '下载新版 APK'),
                    ),
                  ],
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _checkUpdate() async {
    setState(() {
      _checking = true;
      _status = '正在检查 OpenList 更新源...';
    });
    try {
      final update = await _updates.check();
      if (!mounted) return;
      setState(() {
        _update = update;
        _status = update.available ? '发现新版本 ${update.version}' : '当前已经是最新版本。';
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
      _status = '正在打开下载链接...';
    });
    try {
      await _updates.openDownload(update);
      if (mounted) setState(() => _status = '已打开下载链接，请按系统提示安装 APK。');
    } catch (error) {
      if (mounted) setState(() => _status = '打开下载失败：$error');
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
    final color = update.available ? AppColors.success : AppColors.muted;
    final title = update.available ? '发现新版本 ${update.version}' : '当前已是最新版本';
    final subtitle = update.available
        ? '当前版本 ${update.currentVersion}，来源：${update.source}，Release：${update.tagName ?? '未知'}。'
        : '当前版本 ${update.currentVersion}，来源：${update.source}。';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surfaceMuted,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            update.available
                ? Icons.system_update_alt_outlined
                : Icons.check_circle_outline,
            color: color,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: const TextStyle(fontWeight: FontWeight.w900)),
                const SizedBox(height: 4),
                Text(subtitle,
                    style:
                        const TextStyle(color: AppColors.muted, height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
