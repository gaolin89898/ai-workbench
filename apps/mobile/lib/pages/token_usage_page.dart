import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';

class TokenUsagePage extends StatefulWidget {
  const TokenUsagePage({super.key});

  @override
  State<TokenUsagePage> createState() => _TokenUsagePageState();
}

class _TokenUsagePageState extends State<TokenUsagePage> {
  TokenUsageSummary? _summary;
  bool _loading = true;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final summary = await WorkspaceScope.of(context).api.tokenUsageSummary();
      if (!mounted) return;
      setState(() {
        _summary = summary;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    final summary = _summary;
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('用量统计'),
            Text('按 AI 工具聚合', style: theme.bodyMedium),
          ],
        ),
        actions: [
          IconButton(
            onPressed: _loading ? null : _refresh,
            icon: const Icon(Icons.refresh, size: 20),
            tooltip: '刷新',
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.lg,
            AppSpacing.lg,
            AppSpacing.lg,
            100,
          ),
          children: [
            if (_loading && summary == null)
              const SizedBox(
                height: 280,
                child: EmptyState('正在加载用量数据...'),
              )
            else if (_error != null)
              _ErrorCard(error: _error!, onRetry: _refresh)
            else if (summary == null)
              const SizedBox(
                height: 280,
                child: EmptyState('暂无数据'),
              )
            else ...[
              _OverviewCards(summary: summary),
              const SizedBox(height: AppSpacing.xl),
              AppSectionTitle(
                '按工具',
                padding: const EdgeInsets.only(left: 2, bottom: AppSpacing.sm),
              ),
              if (summary.providers.isEmpty)
                const _EmptyProviders()
              else
                Column(
                  children: [
                    for (final item in summary.providers) ...[
                      _ProviderCard(item: item),
                      const SizedBox(height: AppSpacing.md),
                    ],
                  ],
                ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 顶部 2x2 概览卡：总输入 / 总输出 / 推理 / 合计。
class _OverviewCards extends StatelessWidget {
  const _OverviewCards({required this.summary});

  final TokenUsageSummary summary;

  @override
  Widget build(BuildContext context) {
    final totals = summary.totals;
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: AppSpacing.md,
      crossAxisSpacing: AppSpacing.md,
      childAspectRatio: 1.5,
      children: [
        _StatCard(
          label: '总输入',
          value: totals.inputTokens,
          icon: Icons.arrow_downward_rounded,
          iconColor: AppColors.info,
          iconBg: AppColors.info.withValues(alpha: 0.12),
        ),
        _StatCard(
          label: '总输出',
          value: totals.outputTokens,
          icon: Icons.arrow_upward_rounded,
          iconColor: AppColors.success,
          iconBg: AppColors.success.withValues(alpha: 0.12),
        ),
        _StatCard(
          label: '推理',
          value: totals.reasoningTokens,
          icon: Icons.psychology_outlined,
          iconColor: AppColors.warning,
          iconBg: AppColors.warning.withValues(alpha: 0.12),
        ),
        _StatCard(
          label: '合计',
          value: totals.totalTokens,
          icon: Icons.functions_rounded,
          iconColor: AppColors.primary,
          iconBg: AppColors.primaryMuted,
          highlight: true,
        ),
      ],
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.label,
    required this.value,
    required this.icon,
    required this.iconColor,
    required this.iconBg,
    this.highlight = false,
  });

  final String label;
  final int value;
  final IconData icon;
  final Color iconColor;
  final Color iconBg;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: highlight ? AppColors.primarySoft : AppColors.surface,
        border: Border.all(
          color: highlight ? AppColors.primaryMuted : AppColors.border,
        ),
        borderRadius: BorderRadius.circular(AppRadius.lg),
        boxShadow: AppShadows.card,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              Container(
                width: 32,
                height: 32,
                decoration: BoxDecoration(
                  color: iconBg,
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, size: 16, color: iconColor),
              ),
              const SizedBox(width: AppSpacing.sm),
              Text(
                label,
                style: theme.bodySmall?.copyWith(
                  color: highlight ? AppColors.primary : AppColors.secondary,
                  fontWeight: highlight ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            _formatTokens(value),
            style: theme.titleLarge?.copyWith(
              color: highlight ? AppColors.primary : AppColors.ink,
              fontWeight: FontWeight.w700,
              letterSpacing: -0.01,
            ),
          ),
        ],
      ),
    );
  }
}

/// 单个工具的用量卡片。
class _ProviderCard extends StatelessWidget {
  const _ProviderCard({required this.item});

  final TokenUsageSummaryItem item;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return AppCard(
      borderRadius: AppRadius.lg,
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              AppIconBox(
                icon: _providerIcon(item.providerId),
                size: 34,
                iconSize: 18,
                background: AppColors.primarySoft,
                foreground: AppColors.primary,
                borderRadius: 14,
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Text(
                  _providerName(item.providerId),
                  style: theme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              Text(
                _formatTokens(item.totalTokens),
                style: theme.titleMedium?.copyWith(
                  color: AppColors.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.xs,
            children: [
              _Chip(label: '输入', value: item.inputTokens),
              _Chip(label: '输出', value: item.outputTokens),
              _Chip(label: '推理', value: item.reasoningTokens),
              _Chip(label: '次数', value: item.turnCount),
            ],
          ),
        ],
      ),
    );
  }

  IconData _providerIcon(String id) {
    switch (id) {
      case 'codex':
        return Icons.terminal_outlined;
      case 'claude':
        return Icons.smart_toy_outlined;
      case 'opencode':
        return Icons.code_outlined;
      default:
        return Icons.memory_outlined;
    }
  }

  String _providerName(String id) {
    switch (id) {
      case 'codex':
        return 'Codex';
      case 'claude':
        return 'Claude Code';
      case 'opencode':
        return 'OpenCode';
      case 'mimo':
        return 'MiMo Code';
      default:
        return id;
    }
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.surfaceMuted,
        borderRadius: BorderRadius.circular(AppRadius.md),
      ),
      child: Text(
        '$label · ${_formatTokens(value)}',
        style: theme.bodySmall?.copyWith(color: AppColors.secondary),
      ),
    );
  }
}

/// 空状态：圆形图标 + 标题 + 副标题。
class _EmptyProviders extends StatelessWidget {
  const _EmptyProviders();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(AppRadius.lg),
      ),
      child: Column(
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: const BoxDecoration(
              color: AppColors.surfaceMuted,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.bar_chart_rounded, size: 28, color: AppColors.muted),
          ),
          const SizedBox(height: AppSpacing.lg),
          Text('暂无用量数据', style: theme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text(
            '发起一次 AI 会话后会自动统计',
            style: theme.bodySmall?.copyWith(color: AppColors.muted),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

/// 错误状态：红色软背景 + 图标 + 标题/副标题 + 重试按钮。
class _ErrorCard extends StatelessWidget {
  const _ErrorCard({required this.error, required this.onRetry});

  final String error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: BoxDecoration(
        color: AppColors.dangerSoft,
        border: Border.all(color: AppColors.danger.withValues(alpha: 0.2)),
        borderRadius: BorderRadius.circular(AppRadius.lg),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: AppColors.danger.withValues(alpha: 0.12),
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.error_outline, size: 16, color: AppColors.danger),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('加载失败', style: theme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Text(
                  error,
                  style: theme.bodySmall?.copyWith(color: AppColors.secondary),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          OutlinedButton(
            onPressed: onRetry,
            style: OutlinedButton.styleFrom(
              foregroundColor: AppColors.primary,
              side: const BorderSide(color: AppColors.border),
              backgroundColor: AppColors.surface,
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: 4),
              minimumSize: const Size(0, 32),
              textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
            ),
            child: const Text('重试'),
          ),
        ],
      ),
    );
  }
}

String _formatTokens(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(2)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}K';
  return '$n';
}
