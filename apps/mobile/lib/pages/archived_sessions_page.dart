import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';

class ArchivedSessionsPage extends StatelessWidget {
  const ArchivedSessionsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) {
        final archivedSessions = ws.sessions.where((s) => s.archived).toList();
        return Scaffold(
          appBar: AppBar(
            title: const Text('已归档对话'),
            actions: [
              Padding(
                padding: const EdgeInsets.only(right: AppSpacing.lg),
                child: Center(
                  child: AppStatusBadge(
                    '${archivedSessions.length} 个',
                    style: AppStatusStyle.primary,
                  ),
                ),
              ),
            ],
          ),
          body: archivedSessions.isEmpty
              ? const Center(
                  child: EmptyState(
                    '暂无已归档的 AI 会话',
                    icon: Icons.archive_outlined,
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 86),
                  prototypeItem:
                      _ArchivedSessionTile(session: archivedSessions.first),
                  addAutomaticKeepAlives: false,
                  addSemanticIndexes: false,
                  itemCount: archivedSessions.length,
                  itemBuilder: (context, index) {
                    final session = archivedSessions[index];
                    return _ArchivedSessionTile(session: session);
                  },
                ),
        );
      },
    );
  }
}

class _ArchivedSessionTile extends StatelessWidget {
  const _ArchivedSessionTile({required this.session});

  final AiSessionMeta session;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    final project =
        ws.projects.where((item) => item.path == session.summary).firstOrNull;
    final title = ws.getEffectiveTitle(session);

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: AppCard(
        borderRadius: AppRadius.lg,
        padding: EdgeInsets.zero,
        child: ListTile(
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          leading: AppIconBox(
            icon: Icons.chat_outlined,
            size: 40,
            iconSize: 20,
            borderRadius: AppRadius.full,
            background: AppColors.surfaceMuted,
            foreground: AppColors.primary,
          ),
          title: Text(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: AppColors.ink,
            ),
          ),
          subtitle: Text(
            project?.name ?? session.summary ?? '未绑定项目',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12, color: AppColors.muted),
          ),
          trailing: TextButton(
            onPressed: () => ws.archiveSession(session, false),
            child: const Text('恢复'),
          ),
        ),
      ),
    );
  }
}
