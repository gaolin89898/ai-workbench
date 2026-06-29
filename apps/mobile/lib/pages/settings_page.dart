import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../services/api_client.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'login_page.dart';
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
    final theme = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.lg,
          AppSpacing.lg,
          AppSpacing.lg,
          100,
        ),
        children: [
          // 状态消息
          if (_status != null)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.md),
              child: Text(
                _status!,
                style: const TextStyle(color: AppColors.muted, fontSize: 12),
              ),
            ),
          if (settings == null)
            const SizedBox(height: 280, child: EmptyState('正在读取设置...'))
          else ...[
            // ---- 菜单 section ----
            AppSectionTitle('菜单', padding: const EdgeInsets.only(bottom: AppSpacing.sm)),
            AppCard(
              borderRadius: AppRadius.x2l,
              padding: EdgeInsets.zero,
              child: Column(
                children: [
                  _MenuRow(
                    icon: Icons.link,
                    name: '连接',
                    background: AppColors.primarySoftSolid,
                    foreground: AppColors.primary,
                    onTap: () {},
                  ),
                  const Divider(height: 1, color: AppColors.divider),
                  _MenuRow(
                    icon: Icons.shield_outlined,
                    name: '安全与历史',
                    background: AppColors.successSoft,
                    foreground: AppColors.successDeep,
                    onTap: () {},
                  ),
                  const Divider(height: 1, color: AppColors.divider),
                  _MenuRow(
                    icon: Icons.devices_outlined,
                    name: '设备配对',
                    background: AppColors.warningSoft,
                    foreground: AppColors.warningDeep,
                    onTap: () {},
                  ),
                  const Divider(height: 1, color: AppColors.divider),
                  _MenuRow(
                    icon: Icons.archive_outlined,
                    name: '已归档对话',
                    background: AppColors.surfaceMuted,
                    foreground: AppColors.secondary,
                    onTap: () {},
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.xl),

            // ---- 偏好 section ----
            AppSectionTitle('偏好', padding: const EdgeInsets.only(bottom: AppSpacing.sm)),
            AppCard(
              borderRadius: AppRadius.x2l,
              padding: EdgeInsets.zero,
              child: Column(
                children: [
                  _SwitchRow(
                    icon: Icons.warning_amber_outlined,
                    background: AppColors.primarySoftSolid,
                    foreground: AppColors.primary,
                    title: '高危内容确认',
                    subtitle: '发送危险命令或敏感内容前要求确认。',
                    value: settings.riskConfirmationEnabled,
                    onChanged: (value) => setState(() => _settings = UserSettings(
                          commandLoggingEnabled: settings.commandLoggingEnabled,
                          riskConfirmationEnabled: value,
                          outputBufferLines: settings.outputBufferLines,
                          autoReconnectEnabled: settings.autoReconnectEnabled,
                        )),
                  ),
                  const Divider(height: 1, color: AppColors.divider),
                  _SwitchRow(
                    icon: Icons.sync_outlined,
                    background: AppColors.infoSoft,
                    foreground: AppColors.info,
                    title: '自动重连',
                    subtitle: '网络恢复后重连移动端 WebSocket。',
                    value: settings.autoReconnectEnabled,
                    onChanged: (value) => setState(() => _settings = UserSettings(
                          commandLoggingEnabled: settings.commandLoggingEnabled,
                          riskConfirmationEnabled: settings.riskConfirmationEnabled,
                          outputBufferLines: settings.outputBufferLines,
                          autoReconnectEnabled: value,
                        )),
                  ),
                  const Divider(height: 1, color: AppColors.divider),
                  _SwitchRow(
                    icon: Icons.history_edu_outlined,
                    background: AppColors.successSoft,
                    foreground: AppColors.successDeep,
                    title: '记录命令审计',
                    subtitle: '云端保存命令摘要和风险日志。',
                    value: settings.commandLoggingEnabled,
                    onChanged: (value) => setState(() => _settings = UserSettings(
                          commandLoggingEnabled: value,
                          riskConfirmationEnabled: settings.riskConfirmationEnabled,
                          outputBufferLines: settings.outputBufferLines,
                          autoReconnectEnabled: settings.autoReconnectEnabled,
                        )),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.xl),

            // ---- 输出缓冲行数 ----
            AppCard(
              borderRadius: AppRadius.x2l,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '输出缓冲行数：${settings.outputBufferLines}',
                    style: theme.titleMedium,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '控制终端输出和日志窗口保留的最近行数。',
                    style: theme.bodyMedium,
                  ),
                  Slider(
                    min: 1000,
                    max: 20000,
                    divisions: 19,
                    value: settings.outputBufferLines
                        .toDouble()
                        .clamp(1000, 20000)
                        .toDouble(),
                    label: '${settings.outputBufferLines}',
                    onChanged: (value) => setState(() => _settings = UserSettings(
                          commandLoggingEnabled: settings.commandLoggingEnabled,
                          riskConfirmationEnabled: settings.riskConfirmationEnabled,
                          outputBufferLines: value.round(),
                          autoReconnectEnabled: settings.autoReconnectEnabled,
                        )),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.md),

            // ---- 应用更新入口 ----
            AppCard(
              borderRadius: AppRadius.x2l,
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const UpdatePage()),
              ),
              child: Row(
                children: [
                  AppIconBox(
                    icon: Icons.system_update_alt_outlined,
                    size: 38,
                    iconSize: 18,
                    background: AppColors.primarySoftSolid,
                    foreground: AppColors.primary,
                    borderRadius: 14,
                  ),
                  const SizedBox(width: AppSpacing.md),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('应用更新', style: theme.titleMedium),
                        const SizedBox(height: 2),
                        Text(
                          '检查新版 APK 并打开下载链接。',
                          style: theme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right, size: 18, color: AppColors.muted),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.lg),

            // ---- 保存按钮 ----
            FilledButton(
              onPressed: _save,
              child: const Text('保存设置'),
            ),
            const SizedBox(height: AppSpacing.md),

            // ---- 退出登录（白底红边） ----
            OutlinedButton(
              style: OutlinedButton.styleFrom(
                backgroundColor: AppColors.surface,
                foregroundColor: AppColors.danger,
                side: const BorderSide(color: AppColors.danger),
                minimumSize: const Size.fromHeight(50),
                textStyle: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(18),
                ),
              ),
              onPressed: _logout,
              child: const Text('退出登录'),
            ),
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
      final saved = await WorkspaceScope.of(context).api.updateSettings(settings);
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

  Future<void> _logout() async {
    final controller = WorkspaceScope.of(context);
    controller.dispose();
    await ApiClient.clearStoredToken();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginPage()),
      (_) => false,
    );
  }
}

// =============================================================================
// 内部组件
// =============================================================================

/// 菜单行：图标方框 + 名称 + 右箭头。
class _MenuRow extends StatelessWidget {
  const _MenuRow({
    required this.icon,
    required this.name,
    required this.background,
    required this.foreground,
    required this.onTap,
  });

  final IconData icon;
  final String name;
  final Color background;
  final Color foreground;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 58),
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Row(
          children: [
            AppIconBox(
              icon: icon,
              size: 38,
              iconSize: 18,
              background: background,
              foreground: foreground,
              borderRadius: 14,
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Text(
                name,
                style: const TextStyle(
                  color: AppColors.ink,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const Icon(Icons.chevron_right, size: 18, color: AppColors.muted),
          ],
        ),
      ),
    );
  }
}

/// 偏好开关行：图标方框 + 标题/副标题 + Switch。
class _SwitchRow extends StatelessWidget {
  const _SwitchRow({
    required this.icon,
    required this.background,
    required this.foreground,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  final IconData icon;
  final Color background;
  final Color foreground;
  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.sm,
      ),
      child: Row(
        children: [
          AppIconBox(
            icon: icon,
            size: 38,
            iconSize: 18,
            background: background,
            foreground: foreground,
            borderRadius: 14,
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: AppColors.ink,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 11,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
          Switch(value: value, onChanged: onChanged),
        ],
      ),
    );
  }
}
