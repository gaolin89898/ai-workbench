import 'package:flutter/material.dart';

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
                    _ProviderCard(provider: _providers[i]),
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

// =============================================================================
// Provider 静态数据
// =============================================================================

/// Provider 状态三态
enum _ProviderStatus { signedIn, needLogin, notDetected }

/// 单个 Provider 的展示数据
class _ProviderInfo {
  const _ProviderInfo({
    required this.id,
    required this.name,
    required this.command,
    required this.icon,
    required this.status,
    required this.installed,
    required this.version,
    required this.path,
  });

  final String id;
  final String name;
  final String command;
  final IconData icon;
  final _ProviderStatus status;
  final bool installed;
  final String version;
  final String path;
}

/// 4 个硬编码 Provider（按设计稿）
const _providers = <_ProviderInfo>[
  _ProviderInfo(
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    icon: Icons.terminal,
    status: _ProviderStatus.signedIn,
    installed: true,
    version: 'v0.9.7',
    path: '/usr/local/bin/codex',
  ),
  _ProviderInfo(
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    icon: Icons.smart_toy,
    status: _ProviderStatus.needLogin,
    installed: true,
    version: 'v1.8.4',
    path: '登录后启用远程模型',
  ),
  _ProviderInfo(
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    icon: Icons.code,
    status: _ProviderStatus.signedIn,
    installed: true,
    version: 'v0.6.2',
    path: '/usr/local/bin/opencode',
  ),
  _ProviderInfo(
    id: 'deepseek',
    name: 'DeepSeek',
    command: 'deepseek',
    icon: Icons.memory,
    status: _ProviderStatus.notDetected,
    installed: false,
    version: '—',
    path: '未发现 deepseek-cli',
  ),
  _ProviderInfo(
    id: 'mimo',
    name: 'MiMo Code',
    command: 'mimo',
    icon: Icons.auto_fix_high,
    status: _ProviderStatus.signedIn,
    installed: true,
    version: 'v0.1.0',
    path: '/home/gl/.mimocode/bin/mimo',
  ),
];

// =============================================================================
// 应用信息卡
// =============================================================================

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
                      'AI 工作台',
                      style: textTheme.titleLarge?.copyWith(
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    const AppStatusBadge(
                      'v0.3.2',
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
  const _ProviderCard({required this.provider});

  final _ProviderInfo provider;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
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
              _buildStatusBadge(),
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
                provider.installed ? '已安装' : '未安装',
                style: textTheme.bodyMedium?.copyWith(
                  color: provider.installed
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
                provider.version,
                style: textTheme.bodyMedium?.copyWith(
                  fontFamily: 'monospace',
                  color: provider.installed
                      ? AppColors.secondary
                      : AppColors.muted,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Text('路径/账号', style: textTheme.bodySmall),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Text(
                  provider.path,
                  style: textTheme.bodySmall,
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

  /// 状态徽章三态映射
  AppStatusBadge _buildStatusBadge() {
    switch (provider.status) {
      case _ProviderStatus.signedIn:
        return const AppStatusBadge('已登录', style: AppStatusStyle.primary);
      case _ProviderStatus.needLogin:
        return const AppStatusBadge('需登录', style: AppStatusStyle.neutral);
      case _ProviderStatus.notDetected:
        return const AppStatusBadge('未检测到', style: AppStatusStyle.neutral);
    }
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
