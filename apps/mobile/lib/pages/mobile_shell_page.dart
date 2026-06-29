import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_controller.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'chat_page.dart';
import 'providers_page.dart';

class MobileShellPage extends StatefulWidget {
  const MobileShellPage({super.key});

  @override
  State<MobileShellPage> createState() => _MobileShellPageState();
}

class _MobileShellPageState extends State<MobileShellPage> {
  int _index = 0;

  // 切换 tab
  void _goToTab(int i) => setState(() => _index = i);

  @override
  Widget build(BuildContext context) {
    // 4 个 tab：工作台 / 项目 / 会话 / 日志
    final pages = <Widget>[
      _DashboardTab(onNavigate: _goToTab),
      const _ProjectsTab(),
      const _SessionsTab(),
      const _LogsTab(),
    ];
    return Scaffold(
      // IndexedStack 保留各 tab 状态
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: _goToTab,
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

// ===========================================================================
// 工作台 tab
// ===========================================================================
class _DashboardTab extends StatelessWidget {
  const _DashboardTab({this.onNavigate});

  // 用于快捷操作 / 查看全部 跳转 tab
  final void Function(int)? onNavigate;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) => Scaffold(
        body: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _DashboardHeader(onRefresh: ws.refreshWorkspace),
              Expanded(
                child: RefreshIndicator(
                  onRefresh: ws.refreshWorkspace,
                  child: SingleChildScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    // 底部 86 避让导航栏
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 86),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _HeroCard(ws: ws),
                        const SizedBox(height: AppSpacing.xl),
                        const AppSectionTitle('快捷操作', subtitle: '常用工具'),
                        const SizedBox(height: AppSpacing.md),
                        _QuickActions(ws: ws, onNavigate: onNavigate),
                        const SizedBox(height: AppSpacing.xl),
                        AppSectionTitle(
                          '最近会话',
                          trailing: TextButton(
                            onPressed: onNavigate == null
                                ? null
                                : () => onNavigate!(2),
                            child: const Text('查看全部'),
                          ),
                        ),
                        const SizedBox(height: AppSpacing.md),
                        _buildRecentSessions(context, ws),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // 最近会话区：空状态或分组卡
  Widget _buildRecentSessions(BuildContext context, WorkspaceController ws) {
    if (ws.sessions.isEmpty) {
      return const SizedBox(
        height: 220,
        child: EmptyState('还没有 AI 会话。先从项目页创建一个。'),
      );
    }
    final recent = ws.sessions.take(5).toList();
    return AppCard(
      borderRadius: AppRadius.xl,
      padding: EdgeInsets.zero,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.xl),
        child: Column(
          children: [
            for (int i = 0; i < recent.length; i++) ...[
              if (i > 0) const Divider(height: 1, thickness: 1, color: AppColors.divider),
              _GroupedSessionTile(sessionId: recent[i].id),
            ],
          ],
        ),
      ),
    );
  }
}

// 工作台顶栏：问候语 + 刷新按钮
class _DashboardHeader extends StatelessWidget {
  const _DashboardHeader({required this.onRefresh});

  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('欢迎回到 AI 工作台',
                    style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 2),
                Text(
                  _greeting(),
                  style: const TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.w700,
                    color: AppColors.ink,
                    letterSpacing: -0.02,
                    height: 1.2,
                  ),
                ),
              ],
            ),
          ),
          // 38×38 圆形刷新按钮
          Container(
            width: 38,
            height: 38,
            decoration: const BoxDecoration(
              color: AppColors.surface,
              shape: BoxShape.circle,
              border: Border.fromBorderSide(BorderSide(color: AppColors.border)),
              boxShadow: AppShadows.card,
            ),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: onRefresh,
              child: const Center(
                child: Icon(Icons.refresh, size: 18, color: AppColors.secondary),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // 按当前时段返回问候语
  String _greeting() {
    final hour = DateTime.now().hour;
    if (hour < 6) return '深夜好';
    if (hour < 12) return '早上好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }
}

// Hero 卡片：渐变背景 + 装饰圆 + 项目信息 + 统计
class _HeroCard extends StatelessWidget {
  const _HeroCard({required this.ws});

  final WorkspaceController ws;

  @override
  Widget build(BuildContext context) {
    final project = ws.projects.isNotEmpty ? ws.projects.first : null;
    final activeSessions = ws.sessions.where((s) => !s.archived).length;
    final installedProviders =
        ws.providerStatuses.where((p) => p.installed).length;
    return Container(
      decoration: const BoxDecoration(
        gradient: AppColors.heroGradient,
        borderRadius: BorderRadius.all(Radius.circular(AppRadius.x2l)),
        boxShadow: AppShadows.primary,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.x2l),
        child: Stack(
          children: [
            // 装饰圆（半透明白）
            Positioned(
              top: -32,
              right: -24,
              child: Container(
                width: 140,
                height: 140,
                decoration: BoxDecoration(
                  color: Colors.white.withOpacity(0.10),
                  shape: BoxShape.circle,
                ),
              ),
            ),
            Positioned(
              top: 24,
              right: 70,
              child: Container(
                width: 100,
                height: 100,
                decoration: BoxDecoration(
                  color: Colors.white.withOpacity(0.16),
                  shape: BoxShape.circle,
                ),
              ),
            ),
            // 内容
            Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('当前活动项目',
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.white.withOpacity(0.78),
                      )),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          project?.name ?? '暂无活动项目',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w700,
                            color: Colors.white,
                            height: 1.2,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: Colors.white.withOpacity(0.18),
                          borderRadius: BorderRadius.circular(AppRadius.full),
                          border:
                              Border.all(color: Colors.white.withOpacity(0.22)),
                        ),
                        child: Text(
                          project == null ? '待同步' : '运行中',
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            color: Colors.white,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: _HeroStat(
                          value: '${ws.projects.length}',
                          label: '项目',
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _HeroStat(
                          value: '$activeSessions',
                          label: '活跃会话',
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _HeroStat(
                          value:
                              '$installedProviders/${ws.providerStatuses.length}',
                          label: 'AI 工具',
                          // 跳转 Provider 管理
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => WorkspaceScope(
                                controller: ws,
                                child: const ProvidersPage(),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// Hero 统计子卡
class _HeroStat extends StatelessWidget {
  const _HeroStat({required this.value, required this.label, this.onTap});

  final String value;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final content = Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.16),
        borderRadius: BorderRadius.circular(AppRadius.xl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value,
              style: const TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.w700,
                color: Colors.white,
              )),
          const SizedBox(height: 4),
          Text(label,
              style: TextStyle(
                fontSize: 11,
                color: Colors.white.withOpacity(0.78),
              )),
        ],
      ),
    );
    if (onTap == null) return content;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        child: content,
      ),
    );
  }
}

// 快捷操作 4 列
class _QuickActions extends StatelessWidget {
  const _QuickActions({required this.ws, this.onNavigate});

  final WorkspaceController ws;
  final void Function(int)? onNavigate;

  @override
  Widget build(BuildContext context) {
    final actions = <_QuickActionData>[
      _QuickActionData(
        icon: Icons.add_comment_outlined,
        label: '新建会话',
        background: AppColors.primarySoftSolid,
        foreground: AppColors.primary,
        onTap: onNavigate == null ? null : () => onNavigate!(2),
      ),
      _QuickActionData(
        icon: Icons.terminal_outlined,
        label: '打开终端',
        background: AppColors.successSoft,
        foreground: AppColors.successDeep,
        onTap: () {},
      ),
      _QuickActionData(
        icon: Icons.receipt_long_outlined,
        label: '查看日志',
        background: AppColors.warningSoft,
        foreground: AppColors.warningDeep,
        onTap: onNavigate == null ? null : () => onNavigate!(3),
      ),
      _QuickActionData(
        icon: Icons.sync,
        label: '同步项目',
        background: AppColors.infoSoft,
        foreground: AppColors.info,
        onTap: ws.refreshWorkspace,
      ),
    ];
    return Row(
      children: [
        for (int i = 0; i < actions.length; i++) ...[
          if (i > 0) const SizedBox(width: 10),
          Expanded(child: _QuickActionButton(data: actions[i])),
        ],
      ],
    );
  }
}

class _QuickActionData {
  const _QuickActionData({
    required this.icon,
    required this.label,
    required this.background,
    required this.foreground,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final Color background;
  final Color foreground;
  final VoidCallback? onTap;
}

class _QuickActionButton extends StatelessWidget {
  const _QuickActionButton({required this.data});

  final _QuickActionData data;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      onTap: data.onTap,
      borderRadius: 18,
      padding: const EdgeInsets.all(13),
      child: Column(
        children: [
          AppIconBox(
            icon: data.icon,
            size: 38,
            iconSize: 18,
            borderRadius: 14,
            background: data.background,
            foreground: data.foreground,
          ),
          const SizedBox(height: 8),
          Text(data.label,
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w500,
                color: AppColors.secondary,
              )),
        ],
      ),
    );
  }
}

// ===========================================================================
// 项目 tab
// ===========================================================================
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
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 86),
            children: [
              if (ws.projects.isEmpty)
                const SizedBox(
                  height: 360,
                  child: EmptyState('桌面端还没有同步项目。请先在桌面端添加本机项目目录。'),
                )
              else
                ...ws.projects.map((project) => Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: _ProjectCard(project: project, ws: ws),
                    )),
            ],
          ),
        ),
      ),
    );
  }
}

// 项目卡：卡头 + 会话列表
class _ProjectCard extends StatelessWidget {
  const _ProjectCard({required this.project, required this.ws});

  final WorkspaceProject project;
  final WorkspaceController ws;

  @override
  Widget build(BuildContext context) {
    final sessions = ws.sessionsForProject(project.path);
    return AppCard(
      borderRadius: AppRadius.xl,
      padding: EdgeInsets.zero,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.xl),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 卡头：白→浅蓝渐变 + 底边 divider
          Container(
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Colors.white, Color(0xfff8fbff)],
              ),
              border: Border(bottom: BorderSide(color: AppColors.divider)),
            ),
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                AppIconBox(
                  icon: Icons.folder_outlined,
                  size: 42,
                  iconSize: 20,
                  borderRadius: AppRadius.md,
                  background: AppColors.primarySoftSolid,
                  foreground: AppColors.primary,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(project.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                    fontSize: 16,
                                    fontWeight: FontWeight.w700,
                                    color: AppColors.ink)),
                          ),
                          const SizedBox(width: 8),
                          AppStatusBadge(
                            project.gitDirty ? '有变更' : '已同步',
                            style: project.gitDirty
                                ? AppStatusStyle.warning
                                : AppStatusStyle.success,
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          const Icon(Icons.call_split,
                              size: 14, color: AppColors.muted),
                          const SizedBox(width: 4),
                          Flexible(
                            child: Text(
                              '${project.gitBranch ?? 'main'} · ${sessions.length} 个会话',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                  fontSize: 12, color: AppColors.muted),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                // 新建 AI 会话
                IconButton(
                  onPressed: () => _showProviderSelector(context, ws, project),
                  icon: const Icon(Icons.add, color: AppColors.primary),
                  visualDensity: VisualDensity.compact,
                  tooltip: '新建 AI 会话',
                ),
              ],
            ),
          ),
          // 会话列表
          if (sessions.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 20),
              child: Text('暂无会话',
                  style: const TextStyle(fontSize: 12, color: AppColors.muted)),
            )
          else
            for (int i = 0; i < sessions.length; i++) ...[
              if (i > 0) const Divider(height: 1, thickness: 1, color: AppColors.divider),
              _ProjectSessionRow(sessionId: sessions[i].id),
            ],
          ],
        ),
      ),
    );
  }
}

// 项目卡内的会话行
class _ProjectSessionRow extends StatelessWidget {
  const _ProjectSessionRow({required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    final session = ws.sessions.firstWhere((item) => item.id == sessionId);
    return InkWell(
      onTap: () => _openSessionById(context, ws, sessionId),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            AppIconBox(
              icon: _providerIcon(session.providerId),
              size: 32,
              iconSize: 16,
              borderRadius: 9,
              background: AppColors.surfaceMuted,
              foreground: AppColors.primary,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    ws.getEffectiveTitle(session),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                        color: AppColors.ink),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${session.providerId} · ${session.status}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 12, color: AppColors.muted),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(_shortTime(session.updatedAt),
                style: const TextStyle(fontSize: 11, color: AppColors.muted)),
            const SizedBox(width: 4),
            const Icon(Icons.chevron_right, size: 15, color: Color(0xffcbd5e1)),
          ],
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
                  leading: Icon(p.$3,
                      color: installed.contains(p.$1)
                          ? AppColors.primary
                          : AppColors.muted),
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
        builder: (_) =>
            WorkspaceScope(controller: ws, child: ChatPage(session: session)),
      ),
    );
  }
}

// ===========================================================================
// 会话 tab
// ===========================================================================
class _SessionsTab extends StatelessWidget {
  const _SessionsTab();

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: const Text('会话'),
          actions: [
            TextButton(
              onPressed: ws.toggleArchived,
              child: Text(ws.showArchived ? '看活跃' : '已归档'),
            ),
          ],
        ),
        body: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 86),
          children: [
            if (ws.visibleSessions.isEmpty)
              SizedBox(
                  height: 360,
                  child: EmptyState(
                      ws.showArchived ? '没有已归档会话。' : '还没有活跃会话。'))
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

// ===========================================================================
// 日志 tab
// ===========================================================================
class _LogsTab extends StatelessWidget {
  const _LogsTab();

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) => Scaffold(
        appBar: AppBar(title: const Text('日志')),
        body: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 86),
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
                                const Icon(Icons.warning_amber_rounded,
                                    color: AppColors.warning, size: 18),
                                const SizedBox(width: 6),
                              ],
                              Expanded(
                                child: Text(log.title,
                                    style: TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.w600,
                                      color: log.risky
                                          ? AppColors.warningDeep
                                          : AppColors.ink,
                                    )),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          Text(log.body,
                              style: const TextStyle(
                                  color: AppColors.muted,
                                  fontSize: 12,
                                  height: 1.5)),
                          const SizedBox(height: 6),
                          Text(log.createdAt,
                              style: Theme.of(context).textTheme.bodySmall),
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

// ===========================================================================
// 会话相关组件与工具
// ===========================================================================

// 仪表盘最近会话列表中的会话行（无独立卡片外壳，使用 InkWell）
class _GroupedSessionTile extends StatelessWidget {
  const _GroupedSessionTile({required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return InkWell(
      onTap: () => _openSessionById(context, ws, sessionId),
      onLongPress: () => _showSessionMenuById(context, ws, sessionId),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 12),
        child: _SessionTileBody(sessionId: sessionId),
      ),
    );
  }
}

// 会话瓦片（独立卡片，用于会话 tab）
class _SessionTile extends StatelessWidget {
  const _SessionTile({required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AppCard(
      onTap: () => _openSessionById(context, ws, sessionId),
      onLongPress: () => _showSessionMenuById(context, ws, sessionId),
      child: _SessionTileBody(sessionId: sessionId),
    );
  }
}

// 会话行内容（Row），由外层提供点击与 padding
class _SessionTileBody extends StatelessWidget {
  const _SessionTileBody({required this.sessionId});

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
    final runStatus = ws.runStatusBySession[session.id];
    final (statusStyle, statusLabel) = _sessionStatus(session, runStatus);

    return Row(
      children: [
        AppIconBox(
          icon: _providerIcon(session.providerId),
          size: 42,
          iconSize: 20,
          borderRadius: 15,
          background: session.archived
              ? AppColors.surfaceMuted
              : AppColors.primarySoftSolid,
          foreground: session.archived ? AppColors.muted : AppColors.primary,
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  if (pinned) ...[
                    const Icon(Icons.push_pin,
                        size: 14, color: AppColors.primary),
                    const SizedBox(width: 4),
                  ],
                  if (unread) ...[
                    const AppStatusDot(size: 8, color: AppColors.primary),
                    const SizedBox(width: 6),
                  ],
                  Expanded(
                    child: Text(title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: unread ? AppColors.primary : AppColors.ink,
                        )),
                  ),
                  const SizedBox(width: 8),
                  AppStatusBadge(statusLabel, style: statusStyle),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                '${session.providerId} · ${project?.name ?? session.summary ?? '未绑定项目'}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: AppColors.muted),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        const Icon(Icons.chevron_right, size: 18, color: AppColors.muted),
      ],
    );
  }
}

IconData _providerIcon(String providerId) {
  for (final p in _builtInProviders) {
    if (p.$1 == providerId) return p.$3;
  }
  return Icons.extension_outlined;
}

// 会话状态映射为徽章样式与文案
(AppStatusStyle, String) _sessionStatus(
    AiSessionMeta session, String? runStatus) {
  if (session.archived) return (AppStatusStyle.neutral, '已归档');
  if (runStatus != null) return (AppStatusStyle.primary, runStatus);
  switch (session.status) {
    case 'running':
    case 'active':
      return (AppStatusStyle.primary, '运行中');
    case 'idle':
      return (AppStatusStyle.neutral, '空闲');
    case 'error':
      return (AppStatusStyle.danger, '错误');
    default:
      return (AppStatusStyle.neutral,
          session.status.isEmpty ? '空闲' : session.status);
  }
}

// 打开会话
void _openSessionById(
    BuildContext context, WorkspaceController ws, String sessionId) {
  final session = ws.sessions.firstWhere((item) => item.id == sessionId);
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

// 时间戳简短化（MM-dd HH:mm）
String _shortTime(String iso) {
  if (iso.length < 16) return iso;
  return iso.substring(5, 16).replaceAll('T', ' ');
}

// 会话长按菜单
void _showSessionMenuById(
    BuildContext context, WorkspaceController ws, String sessionId) {
  final session = ws.sessions.firstWhere((item) => item.id == sessionId);
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
            leading:
                Icon(unread ? Icons.mark_email_read : Icons.mark_email_unread),
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
            leading: Icon(
                session.archived ? Icons.unarchive_outlined : Icons.archive_outlined),
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

// 重命名对话框
void _showRenameDialog(
    BuildContext context, WorkspaceController ws, AiSessionMeta session) {
  final ctrl = TextEditingController(text: ws.getEffectiveTitle(session));
  showDialog(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('重命名会话'),
      content: TextField(
        controller: ctrl,
        autofocus: true,
        decoration: const InputDecoration(hintText: '输入新的会话名称'),
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.of(ctx).pop(), child: const Text('取消')),
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

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    for (final item in this) {
      return item;
    }
    return null;
  }
}
