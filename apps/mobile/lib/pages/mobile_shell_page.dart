import 'package:flutter/material.dart';

import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'chat_page.dart';
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
      const SettingsPage(),
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
          NavigationDestination(
              icon: Icon(Icons.settings_outlined), label: '设置'),
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
                onPressed: ws.refreshWorkspace, icon: const Icon(Icons.refresh))
          ],
        ),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _MetricGrid(
              values: [
                (
                  'Provider',
                  '${ws.providerStatuses.where((item) => item.installed).length}/${ws.providerStatuses.length} 可用'
                ),
                ('项目', '${ws.projects.length} 个'),
                (
                  '会话',
                  '${ws.sessions.where((item) => !item.archived).length} 个活跃'
                ),
              ],
            ),
            const SizedBox(height: 16),
            const Text('最近 AI 会话',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
            const SizedBox(height: 10),
            if (ws.sessions.isEmpty)
              const AppCard(child: Text('还没有 AI 会话。先从项目页创建一个 Codex 会话。'))
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
                                  onPressed: () async {
                                    final session =
                                        await ws.createCodexSession(project);
                                    if (session != null && context.mounted) {
                                      ws.openSession(session);
                                      Navigator.of(context).push(
                                        MaterialPageRoute(
                                          builder: (_) => WorkspaceScope(
                                            controller: ws,
                                            child: ChatPage(session: session),
                                          ),
                                        ),
                                      );
                                    }
                                  },
                                  icon: const Icon(Icons.add),
                                  label: const Text('Codex 会话'),
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
                          Text(log.title,
                              style:
                                  const TextStyle(fontWeight: FontWeight.w900)),
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

  final List<(String, String)> values;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: values
          .map((item) => Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: AppCard(
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

class _SessionTile extends StatelessWidget {
  const _SessionTile({required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    final session = ws.sessions.firstWhere((item) => item.id == sessionId);
    final project =
        ws.projects.where((item) => item.path == session.summary).firstOrNull;
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
      child: Row(
        children: [
          Icon(
              session.providerId == 'codex'
                  ? Icons.smart_toy_outlined
                  : Icons.extension_outlined,
              color: AppColors.primary),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(session.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w900)),
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
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    for (final item in this) {
      return item;
    }
    return null;
  }
}
