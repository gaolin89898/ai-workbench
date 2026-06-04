import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_controller.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'chat_page.dart';
import 'providers_page.dart';
import 'settings_page.dart';

class MobileShellPage extends StatefulWidget {
  const MobileShellPage({super.key});

  @override
  State<MobileShellPage> createState() => _MobileShellPageState();
}

class _MobileShellPageState extends State<MobileShellPage> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      const _DashboardTab(),
      const _ProjectsTab(),
      const _SessionsTab(),
      const _LogsTab(),
    ];
    return Scaffold(
      body: pages[_index],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (value) => setState(() => _index = value),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.space_dashboard_outlined), label: '工作台'),
          NavigationDestination(icon: Icon(Icons.folder_outlined), label: '项目'),
          NavigationDestination(
              icon: Icon(Icons.chat_bubble_outline), label: '会话'),
          NavigationDestination(
              icon: Icon(Icons.receipt_long_outlined), label: '日志'),
        ],
      ),
    );
  }
}

class _DashboardTab extends StatelessWidget {
  const _DashboardTab();

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: Text(ws.selectedDevice?.name ?? '工作台'),
          actions: [
            IconButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => WorkspaceScope(controller: ws, child: const SettingsPage()),
                  ),
                ),
                icon: const Icon(Icons.settings_outlined)),
            IconButton(
                onPressed: ws.refreshWorkspace, icon: const Icon(Icons.refresh)),
          ],
        ),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _MetricGrid(
              values: [
                (
                  'Provider',
                  '${ws.providerStatuses.where((item) => item.installed).length}/${ws.providerStatuses.length} 可用',
                  () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => WorkspaceScope(controller: ws, child: const ProvidersPage()),
                  )),
                ),
                ('项目', '${ws.projects.length} 个', null),
                (
                  '会话',
                  '${ws.sessions.where((item) => !item.archived).length} 个活跃',
                  null
                ),
              ],
            ),
            const SizedBox(height: 16),
            const Text('最近 AI 会话',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
            const SizedBox(height: 10),
            if (ws.sessions.isEmpty)
              const AppCard(child: Text('还没有 AI 会话。先从项目页创建一个。'))
            else
              ...ws.sessions.take(5).map((session) => Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _SessionTile(sessionId: session.id),
                  )),
          ],
        ),
      ),
    );
  }
}

class _ProjectsTab extends StatelessWidget {
  const _ProjectsTab();

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) => Scaffold(
        appBar: AppBar(title: const Text('项目')),
        body: RefreshIndicator(
          onRefresh: ws.refreshWorkspace,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (ws.projects.isEmpty)
                const SizedBox(
                    height: 360,
                    child: EmptyState('桌面端还没有同步项目。请先在桌面端添加本机项目目录。'))
              else
                ...ws.projects.map((project) => Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: AppCard(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(project.name,
                                style: const TextStyle(
                                    fontSize: 17, fontWeight: FontWeight.w900)),
                            const SizedBox(height: 4),
                            Text(project.path,
                                style: const TextStyle(
                                    color: AppColors.muted, fontSize: 12)),
                            const SizedBox(height: 10),
                            Row(
                              children: [
                                Chip(
                                  label: Text(project.gitDirty ? '有变更' : '干净'),
                                  visualDensity: VisualDensity.compact,
                                ),
                                const Spacer(),
                                FilledButton.icon(
                                  onPressed: () => _showProviderSelector(context, ws, project),
                                  icon: const Icon(Icons.add),
                                  label: const Text('AI 会话'),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    )),
            ],
          ),
        ),
      ),
    );
  }
}

const _builtInProviders = [
  ('codex', 'Codex', Icons.smart_toy_outlined),
  ('claude', 'Claude Code', Icons.auto_awesome_outlined),
  ('opencode', 'OpenCode', Icons.code_outlined),
  ('deepseek', 'DeepSeek', Icons.psychology_outlined),
];

Future<void> _showProviderSelector(
    BuildContext context, WorkspaceController ws, WorkspaceProject project) async {
  final installed =
      ws.providerStatuses.where((s) => s.installed).map((s) => s.providerId).toSet();
  final choice = await showDialog<(String, String)>(
    context: context,
    builder: (ctx) => SimpleDialog(
      title: const Text('选择 AI Provider'),
      children: _builtInProviders
          .map((p) => SimpleDialogOption(
                onPressed: () => Navigator.of(ctx).pop((p.$1, p.$2)),
                child: ListTile(
                  leading: Icon(p.$3, color: installed.contains(p.$1) ? AppColors.primary : AppColors.muted),
                  title: Text(p.$2),
                  subtitle: Text(installed.contains(p.$1) ? '已安装' : '未检测到'),
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                ),
              ))
          .toList(),
    ),
  );
  if (choice == null || !context.mounted) return;
  final session = await ws.createSession(project, providerId: choice.$1);
  if (session != null && context.mounted) {
    ws.openSession(session);
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => WorkspaceScope(controller: ws, child: ChatPage(session: session)),
      ),
    );
  }
}

class _SessionsTab extends StatelessWidget {
  const _SessionsTab();

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: const Text('AI 会话'),
          actions: [
            TextButton(
              onPressed: ws.toggleArchived,
              child: Text(ws.showArchived ? '看活跃' : '已归档'),
            ),
          ],
        ),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (ws.visibleSessions.isEmpty)
              SizedBox(
                  height: 360,
                  child: EmptyState(ws.showArchived ? '没有已归档会话。' : '还没有活跃会话。'))
            else
              ...ws.visibleSessions.map((session) => Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _SessionTile(sessionId: session.id),
                  )),
          ],
        ),
      ),
    );
  }
}

class _LogsTab extends StatelessWidget {
  const _LogsTab();

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) => Scaffold(
        appBar: AppBar(title: const Text('运行日志')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (ws.logs.isEmpty)
              const SizedBox(height: 360, child: EmptyState('暂无日志。'))
            else
              ...ws.logs.map((log) => Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: AppCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              if (log.risky) ...[
                                const Icon(Icons.warning_amber_rounded, color: Colors.orange, size: 18),
                                const SizedBox(width: 6),
                              ],
                              Expanded(
                                child: Text(log.title,
                                    style: TextStyle(
                                        fontWeight: FontWeight.w900,
                                        color: log.risky ? Colors.orange : null)),
                              ),
                            ],
                          ),
                          const SizedBox(height: 4),
                          Text(log.body,
                              style: const TextStyle(
                                  color: AppColors.muted, height: 1.4)),
                          const SizedBox(height: 4),
                          Text(log.createdAt,
                              style: const TextStyle(
                                  color: AppColors.muted, fontSize: 11)),
                        ],
                      ),
                    ),
                  )),
          ],
        ),
      ),
    );
  }
}

class _MetricGrid extends StatelessWidget {
  const _MetricGrid({required this.values});

  final List<(String, String, VoidCallback?)> values;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: values
          .map((item) => Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: AppCard(
                    onTap: item.$3,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(item.$1,
                            style: const TextStyle(
                                color: AppColors.muted,
                                fontSize: 12,
                                fontWeight: FontWeight.w800)),
                        const SizedBox(height: 8),
                        Text(item.$2,
                            style:
                                const TextStyle(fontWeight: FontWeight.w900)),
                      ],
                    ),
                  ),
                ),
              ))
          .toList(),
    );
  }
}

IconData _providerIcon(String providerId) {
  for (final p in _builtInProviders) {
    if (p.$1 == providerId) return p.$3;
  }
  return Icons.extension_outlined;
}

class _SessionTile extends StatelessWidget {
  const _SessionTile({required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    final session = ws.sessions.firstWhere((item) => item.id == sessionId);
    final project =
        ws.projects.where((item) => item.path == session.summary).firstOrNull;
    final pinned = ws.isSessionPinned(session.id);
    final unread = ws.isSessionUnread(session.id);
    final title = ws.getEffectiveTitle(session);
    return AppCard(
      onTap: () {
        ws.openSession(session);
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => WorkspaceScope(
              controller: ws,
              child: ChatPage(session: session),
            ),
          ),
        );
      },
      onLongPress: () => _showSessionMenu(context, ws, session),
      child: Row(
        children: [
          Icon(_providerIcon(session.providerId), color: AppColors.primary),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    if (pinned) ...[
                      const Icon(Icons.push_pin, size: 14, color: AppColors.primary),
                      const SizedBox(width: 4),
                    ],
                    if (unread) ...[
                      Container(
                        width: 8,
                        height: 8,
                        margin: const EdgeInsets.only(right: 6),
                        decoration: const BoxDecoration(shape: BoxShape.circle, color: AppColors.primary),
                      ),
                    ],
                    Expanded(
                      child: Text(title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontWeight: FontWeight.w900,
                            color: unread ? AppColors.primary : null,
                          )),
                    ),
                  ],
                ),
                Text(
                  '${session.providerId} · ${project?.name ?? session.summary ?? '未绑定项目'}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: AppColors.muted, fontSize: 12),
                ),
              ],
            ),
          ),
          if (ws.runStatusBySession[session.id] != null)
            Text(ws.runStatusBySession[session.id]!,
                style: const TextStyle(color: AppColors.muted, fontSize: 11))
          else
            Text(session.archived ? '已归档' : session.status,
                style: const TextStyle(color: AppColors.muted, fontSize: 11)),
        ],
      ),
    );
  }

  void _showSessionMenu(BuildContext context, WorkspaceController ws, AiSessionMeta session) {
    final pinned = ws.isSessionPinned(session.id);
    final unread = ws.isSessionUnread(session.id);
    showModalBottomSheet(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text('重命名'),
              onTap: () {
                Navigator.of(ctx).pop();
                _showRenameDialog(context, ws, session);
              },
            ),
            ListTile(
              leading: Icon(pinned ? Icons.push_pin : Icons.push_pin_outlined),
              title: Text(pinned ? '取消置顶' : '置顶'),
              onTap: () {
                Navigator.of(ctx).pop();
                ws.toggleSessionPinned(session.id);
              },
            ),
            ListTile(
              leading: Icon(unread ? Icons.mark_email_read : Icons.mark_email_unread),
              title: Text(unread ? '标为已读' : '标为未读'),
              onTap: () {
                Navigator.of(ctx).pop();
                if (unread) {
                  ws.markSessionRead(session.id);
                } else {
                  ws.markSessionUnread(session.id);
                }
              },
            ),
            ListTile(
              leading: Icon(session.archived ? Icons.unarchive_outlined : Icons.archive_outlined),
              title: Text(session.archived ? '恢复' : '归档'),
              onTap: () {
                Navigator.of(ctx).pop();
                ws.archiveSession(session, !session.archived);
              },
            ),
          ],
        ),
      ),
    );
  }

  void _showRenameDialog(BuildContext context, WorkspaceController ws, AiSessionMeta session) {
    final ctrl = TextEditingController(text: ws.getEffectiveTitle(session));
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重命名会话'),
        content: TextField(controller: ctrl, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('取消')),
          FilledButton(
            onPressed: () {
              final trimmed = ctrl.text.trim();
              if (trimmed.isNotEmpty) ws.renameSession(session.id, trimmed);
              Navigator.of(ctx).pop();
            },
            child: const Text('确定'),
          ),
        ],
      ),
    );
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
