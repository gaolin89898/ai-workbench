import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
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
        final totalCount = ws.providerStatuses.length;
        return Scaffold(
          backgroundColor: AppColors.background,
          appBar: AppBar(title: const Text('关于')),
          body: RefreshIndicator(
            onRefresh: ws.refreshWorkspace,
            child: CustomScrollView(
              slivers: [
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.lg,
                    AppSpacing.lg,
                    AppSpacing.lg,
                    104,
                  ),
                  sliver: SliverList(
                    delegate: SliverChildListDelegate([
                      // ---- 顶部品牌信息卡 ----
                      _BrandCard(),
                      const SizedBox(height: AppSpacing.xl),
                      // ---- AI 工具 section 标题 ----
                      AppSectionTitle(
                        'AI 工具',
                        subtitle: '本机可用的编程助手组件',
                        trailing: Text(
                          '$totalCount 项',
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 11,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                      const SizedBox(height: AppSpacing.sm),
                    ]),
                  ),
                ),
                if (ws.providerStatuses.isEmpty)
                  const SliverFillRemaining(
                    hasScrollBody: false,
                    child: SizedBox(
                      height: 360,
                      child: EmptyState('暂无 Provider 信息。请确保桌面端在线。'),
                    ),
                  )
                else
                  SliverPadding(
                    padding: const EdgeInsets.fromLTRB(
                      AppSpacing.lg,
                      0,
                      AppSpacing.lg,
                      104,
                    ),
                    sliver: SliverGrid(
                      gridDelegate:
                          const SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: 2,
                        mainAxisSpacing: AppSpacing.md,
                        crossAxisSpacing: AppSpacing.md,
                        childAspectRatio: 0.7,
                      ),
                      delegate: SliverChildBuilderDelegate(
                        (context, index) {
                          final status = ws.providerStatuses[index];
                          final def = ws.providers
                              .where((p) => p.id == status.providerId)
                              .firstOrNull;
                          return _ProviderCard(status: status, def: def);
                        },
                        childCount: ws.providerStatuses.length,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}

// =============================================================================
// 品牌信息卡
// =============================================================================

class _BrandCard extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        // 渐变：白 → #eff6ff(62%) → #dbeafe
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Color(0xffffffff),
            Color(0xffeff6ff),
            Color(0xffdbeafe),
          ],
          stops: [0.0, 0.62, 1.0],
        ),
        borderRadius: BorderRadius.circular(26),
        border: Border.all(color: const Color(0xe6b7dbfe)), // rgba(191,219,254,0.9)
        boxShadow: AppShadows.primary,
      ),
      child: Stack(
        children: [
          // 装饰圆（右上角）
          Positioned(
            top: -32,
            right: -24,
            child: Container(
              width: 128,
              height: 128,
              decoration: const BoxDecoration(
                color: Color(0x142563eb), // rgba(37,99,235,0.08)
                shape: BoxShape.circle,
              ),
            ),
          ),
          // 主内容
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              // AppIconBox 不支持 gradient，这里直接用 Container 实现
              Container(
                width: 62,
                height: 62,
                decoration: BoxDecoration(
                  gradient: AppColors.primaryGradient,
                  borderRadius: BorderRadius.circular(22),
                ),
                child: const Icon(
                  Icons.hexagon_outlined,
                  size: 30,
                  color: AppColors.inverse,
                ),
              ),
              const SizedBox(width: AppSpacing.lg),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text(
                      'AI 工作台',
                      style: TextStyle(
                        color: AppColors.ink,
                        fontSize: 21,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.02,
                      ),
                    ),
                    const SizedBox(height: 2),
                    const Text(
                      '桌面端 AI 编程助手',
                      style: TextStyle(
                        color: AppColors.secondary,
                        fontSize: 14,
                        height: 1.4,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    const AppStatusBadge('v0.3.2', style: AppStatusStyle.primary),
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
  const _ProviderCard({required this.status, this.def});

  final ProviderStatus status;
  final AiProvider? def;

  @override
  Widget build(BuildContext context) {
    final installed = status.installed;
    final signedIn = status.authStatus == 'signed_in';
    final color = _colorFor(status.providerId);

    return AppCard(
      borderRadius: AppRadius.x2l,
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 顶部：图标 + 版本
          Row(
            children: [
              AppIconBox(
                icon: _iconFor(status.providerId),
                size: 32,
                iconSize: 16,
                background: color.withValues(alpha: 0.12),
                foreground: color,
                borderRadius: 11,
              ),
              const Spacer(),
              if (status.version != null)
                Text(
                  'v${status.version}',
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 11,
                    fontWeight: FontWeight.w500,
                  ),
                )
              else if (status.lastCheckedAt.isNotEmpty)
                AppStatusBadge(
                  '已检测',
                  style: AppStatusStyle.neutral,
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          // 名称
          Text(
            def?.name ?? status.providerId,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: AppColors.ink,
              fontSize: 14,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 2),
          // 描述
          Text(
            def?.command ?? _defaultDescription(status.providerId),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: AppColors.muted,
              fontSize: 11,
              height: 1.4,
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          // 登录状态徽章
          if (!installed || !signedIn)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: AppStatusBadge(
                installed ? '未登录' : '未安装',
                style: installed ? AppStatusStyle.warning : AppStatusStyle.neutral,
              ),
            ),
          // 操作按钮
          _buildButton(installed, signedIn),
        ],
      ),
    );
  }

  // 操作按钮
  Widget _buildButton(bool installed, bool signedIn) {
    if (installed && signedIn) {
      // 已安装且已登录 → 已是最新
      return SizedBox(
        width: double.infinity,
        child: OutlinedButton(
          style: OutlinedButton.styleFrom(
            backgroundColor: AppColors.surface,
            foregroundColor: AppColors.secondary,
            side: const BorderSide(color: AppColors.border),
            minimumSize: const Size.fromHeight(34),
            padding: EdgeInsets.zero,
            textStyle: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadius.md),
            ),
          ),
          onPressed: null,
          child: const Text('已是最新'),
        ),
      );
    }
    // 未安装 / 未登录 → 安装 / 升级（占位：暂无实际触发逻辑）
    final label = installed ? '重新登录' : '安装';
    return SizedBox(
      width: double.infinity,
      child: FilledButton(
        style: FilledButton.styleFrom(
          minimumSize: const Size.fromHeight(34),
          padding: EdgeInsets.zero,
          textStyle: const TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.md),
          ),
        ),
        onPressed: () {},
        child: Text(label),
      ),
    );
  }

  // Provider 默认描述
  String _defaultDescription(String id) {
    switch (id) {
      case 'claude':
        return 'Anthropic Claude Code 编程助手';
      case 'codex':
        return 'OpenAI Codex CLI 编程助手';
      case 'opencode':
        return 'OpenCode 开源编程助手';
      case 'gemini':
        return 'Google Gemini CLI 编程助手';
      case 'deepseek':
        return 'DeepSeek CLI 编程助手';
      default:
        return 'AI 编程助手';
    }
  }

  // Provider 图标
  IconData _iconFor(String id) {
    switch (id) {
      case 'codex':
        return Icons.smart_toy_outlined;
      case 'claude':
        return Icons.auto_awesome_outlined;
      case 'opencode':
        return Icons.code_outlined;
      case 'deepseek':
        return Icons.psychology_outlined;
      case 'gemini':
        return Icons.diamond_outlined;
      default:
        return Icons.extension_outlined;
    }
  }

  // Provider 色系
  Color _colorFor(String id) {
    switch (id) {
      case 'claude':
        return const Color(0xff4f46e5); // indigo
      case 'codex':
        return const Color(0xff0284c7); // cyan
      case 'opencode':
        return const Color(0xff16a34a); // green
      case 'gemini':
        return const Color(0xffea580c); // orange
      case 'deepseek':
        return const Color(0xffdb2777); // pink
      default:
        return const Color(0xffef4444); // red
    }
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    for (final item in this) {
      return item;
    }
    return null;
  }
}
