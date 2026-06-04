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
        final installedCount =
            ws.providerStatuses.where((s) => s.installed).length;
        return Scaffold(
          appBar: AppBar(
            title: Text('Provider ($installedCount/${ws.providerStatuses.length} 可用)'),
          ),
          body: RefreshIndicator(
            onRefresh: ws.refreshWorkspace,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (ws.providerStatuses.isEmpty)
                  const SizedBox(
                    height: 360,
                    child: EmptyState('暂无 Provider 信息。请确保桌面端在线。'),
                  )
                else
                  ...ws.providerStatuses.map((status) {
                    final def = ws.providers
                        .where((p) => p.id == status.providerId)
                        .firstOrNull;
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: _ProviderCard(status: status, def: def),
                    );
                  }),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _ProviderCard extends StatelessWidget {
  const _ProviderCard({required this.status, this.def});

  final ProviderStatus status;
  final AiProvider? def;

  @override
  Widget build(BuildContext context) {
    final installed = status.installed;
    final signedIn = status.authStatus == 'signed_in';
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                _iconFor(status.providerId),
                color: installed ? AppColors.primary : AppColors.muted,
                size: 28,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      def?.name ?? status.providerId,
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w900),
                    ),
                    if (def != null)
                      Text(
                        def!.command,
                        style: const TextStyle(
                            color: AppColors.muted, fontSize: 12, fontFamily: 'monospace'),
                      ),
                  ],
                ),
              ),
              _StatusDot(installed: installed),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              _Badge(
                label: installed ? '已安装' : '未安装',
                color: installed ? Colors.green : Colors.orange,
              ),
              _Badge(
                label: signedIn
                    ? '已登录'
                    : status.authStatus == 'signed_out'
                        ? '未登录'
                        : '未检测',
                color: signedIn
                    ? Colors.green
                    : status.authStatus == 'signed_out'
                        ? Colors.red
                        : AppColors.muted,
              ),
              if (status.version != null)
                _Badge(label: 'v${status.version}', color: AppColors.primary),
            ],
          ),
          if (status.lastCheckedAt.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              '上次检测: ${status.lastCheckedAt}',
              style: const TextStyle(color: AppColors.muted, fontSize: 11),
            ),
          ],
        ],
      ),
    );
  }

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
      default:
        return Icons.extension_outlined;
    }
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.installed});

  final bool installed;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 12,
      height: 12,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: installed ? Colors.green : Colors.orange,
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Text(
        label,
        style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w700),
      ),
    );
  }
}
