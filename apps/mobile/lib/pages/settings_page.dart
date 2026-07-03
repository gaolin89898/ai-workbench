import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../services/api_client.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'archived_sessions_page.dart';
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
    final ws = WorkspaceScope.of(context);
    final settings = _settings;
    final theme = Theme.of(context).textTheme;
    // 分组小标题样式：12 w600 muted
    final sectionStyle = theme.labelMedium?.copyWith(
      color: AppColors.muted,
      fontWeight: FontWeight.w600,
      height: 1.4,
    );
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('设置'),
            Text('账户与偏好', style: theme.bodyMedium),
          ],
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.lg,
          AppSpacing.lg,
          AppSpacing.lg,
          100,
        ),
        children: [
          // 状态消息（加载错误 / 自动保存反馈）
          if (_status != null)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.md),
              child: Text(_status!, style: theme.bodyMedium),
            ),
          if (settings == null)
            const SizedBox(height: 280, child: EmptyState('正在读取设置...'))
          else ...[
            // ===== 1. 账户分组 =====
            AppSectionTitle(
              '账户',
              titleStyle: sectionStyle,
              padding: const EdgeInsets.only(left: 2, bottom: AppSpacing.sm),
            ),
            AppCard(
              borderRadius: AppRadius.xl,
              padding: EdgeInsets.zero,
              child: Column(
                children: [
                  _AccountRow(
                    name: 'AI 工作台用户',
                    email: '未绑定邮箱',
                    onTap: () {},
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.xl),

            // ===== 2. 安全分组 =====
            AppSectionTitle(
              '安全',
              titleStyle: sectionStyle,
              padding: const EdgeInsets.only(left: 2, bottom: AppSpacing.sm),
            ),
            AppCard(
              borderRadius: AppRadius.xl,
              padding: EdgeInsets.zero,
              child: Column(
                children: [
                  _Row(
                    icon: Icons.shield_outlined,
                    background: AppColors.successSoft,
                    foreground: AppColors.successDeep,
                    title: '安全与历史',
                    onTap: () {},
                    trailing: const _Chevron(),
                  ),
                  const Divider(height: 1, color: AppColors.divider),
                  _Row(
                    icon: Icons.warning_amber_outlined,
                    background: AppColors.warningSoft,
                    foreground: AppColors.warningDeep,
                    title: '高危内容确认',
                    subtitle: '执行高危命令前需手动确认',
                    trailing: Switch(
                      value: settings.riskConfirmationEnabled,
                      onChanged: (v) => _updateSettings(risk: v),
                    ),
                  ),
                  const Divider(height: 1, color: AppColors.divider),
                  _Row(
                    icon: Icons.history_edu_outlined,
                    background: AppColors.surfaceMuted,
                    foreground: AppColors.secondary,
                    title: '记录命令审计',
                    subtitle: '将执行的命令写入审计日志',
                    trailing: Switch(
                      value: settings.commandLoggingEnabled,
                      onChanged: (v) => _updateSettings(audit: v),
                    ),
                  ),
                  const Divider(height: 1, color: AppColors.divider),
                  _Row(
                    icon: Icons.archive_outlined,
                    background: AppColors.dangerSoft,
                    foreground: AppColors.dangerDeep,
                    title: '已归档对话',
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => WorkspaceScope(
                          controller: ws,
                          child: const ArchivedSessionsPage(),
                        ),
                      ),
                    ),
                    trailing: const _Chevron(),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.xl),

            // ===== 3. 输出分组 =====
            AppSectionTitle(
              '输出',
              titleStyle: sectionStyle,
              padding: const EdgeInsets.only(left: 2, bottom: AppSpacing.sm),
            ),
            AppCard(
              borderRadius: AppRadius.xl,
              padding: EdgeInsets.zero,
              child: _BufferSliderRow(
                value: settings.outputBufferLines,
                onChanged: (v) => setState(
                  () => _settings = _patch(buffer: v.round()),
                ),
                onChangeEnd: (v) => _updateSettings(buffer: v.round()),
              ),
            ),
            const SizedBox(height: AppSpacing.xl),

            // ===== 4. 更多分组 =====
            AppSectionTitle(
              '更多',
              titleStyle: sectionStyle,
              padding: const EdgeInsets.only(left: 2, bottom: AppSpacing.sm),
            ),
            AppCard(
              borderRadius: AppRadius.xl,
              padding: EdgeInsets.zero,
              child: Column(
                children: [
                  _Row(
                    icon: Icons.system_update_alt_outlined,
                    background: AppColors.successSoft,
                    foreground: AppColors.successDeep,
                    title: '应用更新',
                    subtitle: '检查新版 APK 并打开下载链接。',
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => WorkspaceScope(
                          controller: ws,
                          child: const UpdatePage(),
                        ),
                      ),
                    ),
                    trailing: const _Chevron(),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.xl),

            // ===== 退出登录（白底红边） =====
            SizedBox(
              height: 50,
              width: double.infinity,
              child: OutlinedButton(
                style: OutlinedButton.styleFrom(
                  backgroundColor: AppColors.surface,
                  foregroundColor: AppColors.danger,
                  side: BorderSide(
                    color: AppColors.danger.withValues(alpha: 0.24),
                  ),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(18),
                  ),
                ),
                onPressed: _logout,
                child: const Text('退出登录'),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 局部更新 _settings 的便捷方法（保持原有字段映射不变）。
  UserSettings _patch({
    bool? risk,
    bool? audit,
    int? buffer,
  }) {
    final s = _settings!;
    return UserSettings(
      commandLoggingEnabled: audit ?? s.commandLoggingEnabled,
      riskConfirmationEnabled: risk ?? s.riskConfirmationEnabled,
      outputBufferLines: buffer ?? s.outputBufferLines,
      autoReconnectEnabled: s.autoReconnectEnabled,
    );
  }

  Future<void> _updateSettings({
    bool? risk,
    bool? audit,
    int? buffer,
  }) async {
    final previous = _settings;
    if (previous == null) return;
    final next = _patch(risk: risk, audit: audit, buffer: buffer);
    setState(() {
      _settings = next;
      _status = null;
    });
    try {
      final saved = await WorkspaceScope.of(context).api.updateSettings(next);
      if (mounted) setState(() => _settings = saved);
    } catch (error) {
      if (mounted) {
        setState(() {
          _settings = previous;
          _status = error.toString();
        });
      }
    }
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

/// 右侧箭头（统一规格 18 / muted）。
class _Chevron extends StatelessWidget {
  const _Chevron();

  @override
  Widget build(BuildContext context) {
    return const Icon(Icons.chevron_right, size: 18, color: AppColors.muted);
  }
}

/// 通用设置行：34×34 图标方框 + 标题/副标题 + 尾部控件。
/// min_height 58，左右 padding 14，垂直 padding 0。
class _Row extends StatelessWidget {
  const _Row({
    required this.icon,
    required this.background,
    required this.foreground,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
  });

  final IconData icon;
  final Color background;
  final Color foreground;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 58),
        padding: const EdgeInsets.symmetric(horizontal: 14),
        child: Row(
          children: [
            AppIconBox(
              icon: icon,
              size: 34,
              iconSize: 18,
              background: background,
              foreground: foreground,
              borderRadius: 14,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(title, style: theme.titleMedium),
                  if (subtitle != null) ...[
                    const SizedBox(height: 3),
                    Text(subtitle!, style: theme.bodySmall),
                  ],
                ],
              ),
            ),
            if (trailing != null) trailing!,
          ],
        ),
      ),
    );
  }
}

/// 账户信息行：渐变头像方框 + 名称（15 w700）+ 邮箱（13 secondary）+ 箭头。
/// AppIconBox 不支持渐变，此处用 Container 实现（与 providers_page 一致）。
class _AccountRow extends StatelessWidget {
  const _AccountRow({
    required this.name,
    required this.email,
    this.onTap,
  });

  final String name;
  final String email;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 58),
        padding: const EdgeInsets.symmetric(horizontal: 14),
        child: Row(
          children: [
            // 渐变头像方框
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                gradient: AppColors.primaryGradient,
                borderRadius: BorderRadius.circular(14),
              ),
              child: const Icon(Icons.person, size: 18, color: AppColors.inverse),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    name,
                    style: theme.titleMedium?.copyWith(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    email,
                    style: theme.bodyMedium?.copyWith(fontSize: 13),
                  ),
                ],
              ),
            ),
            const _Chevron(),
          ],
        ),
      ),
    );
  }
}

/// 输出缓冲行数滑块行：图标方框 + 标题/副标题 + 当前值 + 滑块。
class _BufferSliderRow extends StatelessWidget {
  const _BufferSliderRow({
    required this.value,
    required this.onChanged,
    required this.onChangeEnd,
  });

  final int value;
  final ValueChanged<double> onChanged;
  final ValueChanged<double> onChangeEnd;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              AppIconBox(
                icon: Icons.list_alt_outlined,
                size: 34,
                iconSize: 18,
                background: AppColors.infoSoft,
                foreground: AppColors.info,
                borderRadius: 14,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('输出缓冲行数', style: theme.titleMedium),
                    const SizedBox(height: 3),
                    Text('控制终端保留的历史行数', style: theme.bodySmall),
                  ],
                ),
              ),
              Text(
                '$value',
                style: theme.bodyMedium?.copyWith(
                  color: AppColors.primary,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Slider(
            value: value.toDouble().clamp(1000, 20000).toDouble(),
            min: 1000,
            max: 20000,
            divisions: 19,
            label: value.round().toString(),
            onChanged: onChanged,
            onChangeEnd: onChangeEnd,
          ),
        ],
      ),
    );
  }
}
