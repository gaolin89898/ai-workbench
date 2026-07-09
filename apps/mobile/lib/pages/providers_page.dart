import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../services/update_service.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';

class ProvidersPage extends StatelessWidget {
  const ProvidersPage({super.key});

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) {
        final statusById = {
          for (final status in ws.providerStatuses) status.providerId: status,
        };
        return Scaffold(
          backgroundColor: AppColors.background,
          appBar: AppBar(title: const Text('AI 工具')),
          body: RefreshIndicator(
            onRefresh: ws.refreshWorkspace,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg,
                AppSpacing.lg,
                AppSpacing.lg,
                28,
              ),
              children: [
                // ---- 应用信息卡 ----
                _AppInfoCard(),
                const SizedBox(height: AppSpacing.xl),
                // ---- 空状态：桌面端未连接时显示 ----
                if (ws.providerStatuses.isEmpty)
                  const SizedBox(
                    height: 360,
                    child: EmptyState('暂无 Provider 信息。请确保桌面端在线。'),
                  )
                else ...[
                  // ---- AI 工具 section 标题 ----
                  AppSectionTitle(
                    'AI 工具',
                    subtitle: '本机可用的编程助手组件',
                  ),
                  const SizedBox(height: AppSpacing.md),
                  // ---- Provider 卡列表（单列） ----
                  for (int i = 0; i < _providers.length; i++) ...[
                    if (i > 0) const SizedBox(height: AppSpacing.md),
                    _ProviderCard(
                      provider: _providers[i],
                      status: statusById[_providers[i].id],
                    ),
                  ],
                  const SizedBox(height: AppSpacing.xl),
                  // ---- 说明卡 ----
                  _ExplanationCard(),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

class _ProviderInfo {
  const _ProviderInfo({
    required this.id,
    required this.name,
    required this.command,
    required this.icon,
  });

  final String id;
  final String name;
  final String command;
  final IconData icon;
}

const _providers = <_ProviderInfo>[
  _ProviderInfo(
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    icon: Icons.terminal,
  ),
  _ProviderInfo(
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    icon: Icons.smart_toy,
  ),
  _ProviderInfo(
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    icon: Icons.code,
  ),
  _ProviderInfo(
    id: 'mimo',
    name: 'MiMo Code',
    command: 'mimo',
    icon: Icons.auto_fix_high,
  ),
];

class _AppInfoCard extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return AppCard(
      borderRadius: AppRadius.xl, // 16
      padding: const EdgeInsets.all(AppSpacing.lg), // 16
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 顶部：图标 + 应用名 + 版本徽章
          Row(
            children: [
              // AppIconBox 不支持 gradient，用 Container + Icon 实现
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  gradient: AppColors.primaryGradient,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: const Icon(
                  Icons.smart_toy,
                  size: 25,
                  color: AppColors.inverse,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'CodeHub AI',
                      style: textTheme.titleLarge?.copyWith(
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    const AppStatusBadge(
                      'v${MobileUpdateService.currentVersion}',
                      style: AppStatusStyle.primary,
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          const Divider(),
          const SizedBox(height: AppSpacing.md),
          // 底部：安装目录 + 检测策略
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('安装目录', style: textTheme.bodySmall),
                    const SizedBox(height: 2),
                    Text(
                      'C:\\Users\\...\\ai-workbench',
                      style: textTheme.bodyMedium?.copyWith(
                        fontFamily: 'monospace',
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.lg),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('检测策略', style: textTheme.bodySmall),
                    const SizedBox(height: 2),
                    Text('自动检测', style: textTheme.bodyMedium),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// =============================================================================
// Provider 卡
// =============================================================================

class _ProviderCard extends StatelessWidget {
  const _ProviderCard({required this.provider, required this.status});

  final _ProviderInfo provider;
  final ProviderStatus? status;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final installed = status?.installed ?? false;
    final version = status?.version?.trim().isNotEmpty == true ? status!.version! : '—';
    final authLabel = _authLabel(status);
    final authColor = _authColor(status);
    return AppCard(
      borderRadius: AppRadius.xl, // 16
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 顶部：图标 + 名称/命令 + 状态徽章
          Row(
            children: [
              AppIconBox(
                icon: provider.icon,
                size: 36,
                iconSize: 18,
                background: AppColors.primarySoftSolid,
                foreground: AppColors.primary,
                borderRadius: AppRadius.md, // 8
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      provider.name,
                      style: textTheme.titleMedium?.copyWith(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      provider.command,
                      style: textTheme.bodySmall?.copyWith(
                        fontFamily: 'monospace',
                      ),
                    ),
                  ],
                ),
              ),
              _buildStatusBadge(status),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          const Divider(),
          const SizedBox(height: AppSpacing.md),
          // 详细信息：安装 / 版本 / 路径
          Row(
            children: [
              Text('安装', style: textTheme.bodySmall),
              const Spacer(),
              Text(
                installed ? '已安装' : '未安装',
                style: textTheme.bodyMedium?.copyWith(
                  color: installed
                      ? AppColors.successDeep
                      : AppColors.warningDeep,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Text('版本', style: textTheme.bodySmall),
              const Spacer(),
              Text(
                version,
                style: textTheme.bodyMedium?.copyWith(
                  fontFamily: 'monospace',
                  color: installed
                      ? AppColors.secondary
                      : AppColors.muted,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Text('登录状态', style: textTheme.bodySmall),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Text(
                  authLabel,
                  style: textTheme.bodySmall?.copyWith(
                    color: authColor,
                    fontWeight: FontWeight.w600,
                  ),
                  textAlign: TextAlign.end,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  AppStatusBadge _buildStatusBadge(ProviderStatus? status) {
    if (status == null) return const AppStatusBadge('未检测', style: AppStatusStyle.neutral);
    if (!status.installed) return const AppStatusBadge('未安装', style: AppStatusStyle.neutral);
    if (status.authStatus == 'signedIn') return const AppStatusBadge('已登录', style: AppStatusStyle.primary);
    if (status.authStatus == 'signedOut') return const AppStatusBadge('未登录', style: AppStatusStyle.neutral);
    return const AppStatusBadge('未知', style: AppStatusStyle.neutral);
  }

  String _authLabel(ProviderStatus? status) {
    if (status == null) return '未检测';
    if (!status.installed) return '未安装';
    if (status.authStatus == 'signedIn') return '已登录';
    if (status.authStatus == 'signedOut') return '未登录';
    return '未知';
  }

  Color _authColor(ProviderStatus? status) {
    if (status == null || !status.installed) return AppColors.muted;
    if (status.authStatus == 'signedIn') return AppColors.successDeep;
    if (status.authStatus == 'signedOut') return AppColors.warningDeep;
    return AppColors.muted;
  }
}

// =============================================================================
// 说明卡
// =============================================================================

class _ExplanationCard extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return AppCard(
      borderRadius: AppRadius.xl, // 16
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('说明', style: textTheme.titleMedium),
          const SizedBox(height: AppSpacing.sm),
          Text(
            'AI 工具需在桌面端安装并登录。移动端仅展示状态，无法直接操作。',
            style: textTheme.bodyLarge?.copyWith(color: AppColors.secondary),
          ),
        ],
      ),
    );
  }
}
