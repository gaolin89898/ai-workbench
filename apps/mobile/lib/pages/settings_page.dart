import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../services/update_service.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  UserSettings? _settings;
  final _updates = const MobileUpdateService();
  String? _status;
  MobileUpdateInfo? _update;
  bool _checkingUpdate = false;
  bool _openingUpdate = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final settings = _settings;
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (_status != null)
            Text(_status!, style: const TextStyle(color: AppColors.muted)),
          if (settings == null)
            const SizedBox(height: 280, child: EmptyState('正在读取设置...'))
          else ...[
            SwitchListTile(
              value: settings.riskConfirmationEnabled,
              title: const Text('高危内容确认'),
              subtitle: const Text('发送危险命令或敏感内容前要求确认。'),
              onChanged: (value) => setState(() => _settings = UserSettings(
                    commandLoggingEnabled: settings.commandLoggingEnabled,
                    riskConfirmationEnabled: value,
                    outputBufferLines: settings.outputBufferLines,
                    autoReconnectEnabled: settings.autoReconnectEnabled,
                  )),
            ),
            SwitchListTile(
              value: settings.autoReconnectEnabled,
              title: const Text('自动重连'),
              subtitle: const Text('网络恢复后重连移动端 WebSocket。'),
              onChanged: (value) => setState(() => _settings = UserSettings(
                    commandLoggingEnabled: settings.commandLoggingEnabled,
                    riskConfirmationEnabled: settings.riskConfirmationEnabled,
                    outputBufferLines: settings.outputBufferLines,
                    autoReconnectEnabled: value,
                  )),
            ),
            SwitchListTile(
              value: settings.commandLoggingEnabled,
              title: const Text('记录命令审计'),
              subtitle: const Text('云端保存命令摘要和风险日志。'),
              onChanged: (value) => setState(() => _settings = UserSettings(
                    commandLoggingEnabled: value,
                    riskConfirmationEnabled: settings.riskConfirmationEnabled,
                    outputBufferLines: settings.outputBufferLines,
                    autoReconnectEnabled: settings.autoReconnectEnabled,
                  )),
            ),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('输出缓冲行数：${settings.outputBufferLines}',
                      style: const TextStyle(fontWeight: FontWeight.w900)),
                  const SizedBox(height: 6),
                  const Text('控制终端输出和日志窗口保留的最近行数。',
                      style: TextStyle(color: AppColors.muted)),
                  Slider(
                    min: 1000,
                    max: 20000,
                    divisions: 19,
                    value: settings.outputBufferLines
                        .toDouble()
                        .clamp(1000, 20000)
                        .toDouble(),
                    label: '${settings.outputBufferLines}',
                    onChanged: (value) =>
                        setState(() => _settings = UserSettings(
                              commandLoggingEnabled:
                                  settings.commandLoggingEnabled,
                              riskConfirmationEnabled:
                                  settings.riskConfirmationEnabled,
                              outputBufferLines: value.round(),
                              autoReconnectEnabled:
                                  settings.autoReconnectEnabled,
                            )),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('应用更新',
                                style: TextStyle(fontWeight: FontWeight.w900)),
                            SizedBox(height: 4),
                            Text('从 GitHub Releases 检查新版 APK。',
                                style: TextStyle(color: AppColors.muted)),
                          ],
                        ),
                      ),
                      FilledButton.tonal(
                        onPressed: _checkingUpdate ? null : _checkUpdate,
                        child: Text(_checkingUpdate ? '检查中' : '检查更新'),
                      ),
                    ],
                  ),
                  if (_update != null) ...[
                    const SizedBox(height: 12),
                    _UpdateStatus(update: _update!),
                    if (_update!.available) ...[
                      const SizedBox(height: 10),
                      FilledButton.icon(
                        onPressed: _openingUpdate ? null : _openUpdate,
                        icon: const Icon(Icons.download_outlined),
                        label: Text(_openingUpdate ? '打开中' : '下载新版 APK'),
                      ),
                    ],
                  ],
                ],
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(onPressed: _save, child: const Text('保存设置')),
          ],
        ],
      ),
    );
  }

  Future<void> _load() async {
    if (_settings != null) return;
    try {
      final settings = await WorkspaceScope.of(context).api.settings();
      if (mounted) setState(() => _settings = settings);
    } catch (error) {
      if (mounted) setState(() => _status = error.toString());
    }
  }

  Future<void> _save() async {
    final settings = _settings;
    if (settings == null) return;
    try {
      final saved =
          await WorkspaceScope.of(context).api.updateSettings(settings);
      if (mounted) {
        setState(() {
          _settings = saved;
          _status = '已保存';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _status = error.toString());
    }
  }

  Future<void> _checkUpdate() async {
    setState(() {
      _checkingUpdate = true;
      _status = '正在检查更新...';
    });
    try {
      final update = await _updates.check();
      if (mounted) {
        setState(() {
          _update = update;
          _status = update.available ? '发现新版本 ${update.version}' : '当前已经是最新版本';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _status = '检查更新失败：$error');
    } finally {
      if (mounted) setState(() => _checkingUpdate = false);
    }
  }

  Future<void> _openUpdate() async {
    final update = _update;
    if (update == null) return;
    setState(() {
      _openingUpdate = true;
      _status = '正在打开下载链接...';
    });
    try {
      await _updates.openDownload(update);
      if (mounted) setState(() => _status = '已打开下载链接，请按系统提示安装 APK。');
    } catch (error) {
      if (mounted) setState(() => _status = '打开下载失败：$error');
    } finally {
      if (mounted) setState(() => _openingUpdate = false);
    }
  }
}

class _UpdateStatus extends StatelessWidget {
  const _UpdateStatus({required this.update});

  final MobileUpdateInfo update;

  @override
  Widget build(BuildContext context) {
    final color = update.available ? AppColors.success : AppColors.muted;
    final title = update.available
        ? '发现新版本 ${update.version}'
        : '当前已是最新版本';
    final subtitle = update.available
        ? '当前版本 ${update.currentVersion}，点击下载后会交给系统浏览器和安装器处理。'
        : '当前版本 ${update.currentVersion}。';
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
                Text(title, style: const TextStyle(fontWeight: FontWeight.w900)),
                const SizedBox(height: 4),
                Text(subtitle,
                    style: const TextStyle(color: AppColors.muted, height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
