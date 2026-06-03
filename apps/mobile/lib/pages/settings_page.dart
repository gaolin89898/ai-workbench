import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'update_page.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  UserSettings? _settings;
  String? _status;

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
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const UpdatePage()),
              ),
              child: const Row(
                children: [
                  Icon(Icons.system_update_alt_outlined),
                  SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('应用更新',
                            style: TextStyle(fontWeight: FontWeight.w900)),
                        SizedBox(height: 4),
                        Text('检查新版 APK 并打开下载链接。',
                            style: TextStyle(color: AppColors.muted)),
                      ],
                    ),
                  ),
                  Icon(Icons.chevron_right),
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
}
