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
            const Text('Token 使用'),
            Text('按 AI 工具聚合的云端用量', style: theme.bodyMedium),
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
                child: EmptyState('正在加载 Token 用量...'),
              )
            else if (_error != null)
              AppCard(
                borderRadius: AppRadius.lg,
                background: AppColors.dangerSoft,
                borderColor: AppColors.danger.withValues(alpha: 0.24),
                child: Text(
                  _error!,
                  style: theme.bodyMedium?.copyWith(color: AppColors.dangerDeep),
                ),
              )
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
                const AppCard(
                  borderRadius: AppRadius.lg,
                  child: EmptyState('暂无 Token 用量数据'),
                )
              else
                AppCard(
                  borderRadius: AppRadius.xl,
                  padding: EdgeInsets.zero,
                  child: Column(
                    children: [
                      for (int i = 0; i < summary.providers.length; i++) ...[
                        if (i > 0)
                          const Divider(height: 1, color: AppColors.divider),
                        _ProviderRow(item: summary.providers[i]),
                      ],
                    ],
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 顶部 4 张概览卡：总输入 / 总输出 / 推理 / 合计。
class _OverviewCards extends StatelessWidget {
  const _OverviewCards({required this.summary});

  final TokenUsageSummary summary;

  @override
  Widget build(BuildContext context) {
    final totals = summary.totals;
    return Row(
      children: [
        Expanded(
          child: _StatCard(
            label: '总输入',
            value: totals.inputTokens,
            color: AppColors.info,
            soft: AppColors.infoSoft,
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: _StatCard(
            label: '总输出',
            value: totals.outputTokens,
            color: AppColors.successDeep,
            soft: AppColors.successSoft,
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: _StatCard(
            label: '推理',
            value: totals.reasoningTokens,
            color: AppColors.warningDeep,
            soft: AppColors.warningSoft,
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: _StatCard(
            label: '合计',
            value: totals.totalTokens,
            color: AppColors.primary,
            soft: AppColors.primarySoftSolid,
            highlight: true,
          ),
        ),
      ],
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.label,
    required this.value,
    required this.color,
    required this.soft,
    this.highlight = false,
  });

  final String label;
  final int value;
  final Color color;
  final Color soft;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
      decoration: BoxDecoration(
        color: highlight ? soft : AppColors.surface,
        border: Border.all(
          color: highlight ? color.withValues(alpha: 0.3) : AppColors.border,
        ),
        borderRadius: BorderRadius.circular(AppRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: theme.bodySmall?.copyWith(color: AppColors.muted),
          ),
          const SizedBox(height: 4),
          Text(
            _formatTokens(value),
            style: theme.titleLarge?.copyWith(
              color: highlight ? color : AppColors.ink,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

/// 单个工具的用量行。
class _ProviderRow extends StatelessWidget {
  const _ProviderRow({required this.item});

  final TokenUsageSummaryItem item;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
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
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  _providerName(item.providerId),
                  style: theme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
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
          const SizedBox(height: 8),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: 4,
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
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.surfaceMuted,
        borderRadius: BorderRadius.circular(AppRadius.full),
      ),
      child: Text(
        '$label · ${_formatTokens(value)}',
        style: theme.bodySmall?.copyWith(color: AppColors.secondary),
      ),
    );
  }
}

String _formatTokens(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(2)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}K';
  return '$n';
}
