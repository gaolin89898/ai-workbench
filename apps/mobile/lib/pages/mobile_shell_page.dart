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

  void _goToTab(int i) => setState(() => _index = i);

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    // 3 个 Tab：工作台 / 项目 / 设置（删除「会话」「日志」tab）
    final pages = <Widget>[
      _DashboardTab(onNavigate: _goToTab),
      const _ProjectsTab(),
      WorkspaceScope(controller: ws, child: const SettingsPage()),
    ];
    return Scaffold(
      // IndexedStack 保留各 tab 状态
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: _goToTab,
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.dashboard_outlined),
            selectedIcon: Icon(Icons.dashboard),
            label: '工作台',
          ),
          NavigationDestination(
            icon: Icon(Icons.folder_outlined),
            selectedIcon: Icon(Icons.folder),
            label: '项目',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: '设置',
          ),
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
              _DashboardHeader(ws: ws),
              Expanded(
                child: RefreshIndicator(
                  onRefresh: ws.refreshWorkspace,
                  child: SingleChildScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    // 底部 96 避让导航栏
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _HeroCard(ws: ws),
                        const SizedBox(height: AppSpacing.xl),
                        const AppSectionTitle('快捷操作'),
                        const SizedBox(height: AppSpacing.md),
                        _QuickActions(ws: ws, onNavigate: onNavigate),
                        const SizedBox(height: AppSpacing.xl),
                        AppSectionTitle(
                          '项目概览',
                          trailing: TextButton(
                            onPressed: onNavigate == null
                                ? null
                                : () => onNavigate!(1),
                            child: const Text('管理'),
                          ),
                        ),
                        const SizedBox(height: AppSpacing.md),
                        _ProjectOverview(ws: ws),
                        const SizedBox(height: AppSpacing.xl),
                        AppSectionTitle(
                          '最近会话',
                          trailing: TextButton(
                            onPressed: onNavigate == null
                                ? null
                                : () => onNavigate!(1),
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

  // 最近会话区：空状态或会话列表卡
  Widget _buildRecentSessions(BuildContext context, WorkspaceController ws) {
    if (ws.sessions.isEmpty) {
      return const SizedBox(
        height: 220,
        child: EmptyState('还没有 AI 会话。先从项目页创建一个。'),
      );
    }
    final recent = ws.sessions.take(5).toList();
    return AppCard(
      borderRadius: AppRadius.lg,
      padding: EdgeInsets.zero,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        child: Column(
          children: [
            for (int i = 0; i < recent.length; i++) ...[
              if (i > 0)
                const Divider(height: 1, thickness: 1, color: AppColors.divider),
              _GroupedSessionTile(sessionId: recent[i].id),
            ],
          ],
        ),
      ),
    );
  }
}

// 工作台顶栏：副标题 + 主标题"工作台" + 右侧设备切换器按钮
class _DashboardHeader extends StatelessWidget {
  const _DashboardHeader({required this.ws});

  final WorkspaceController ws;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    final activeSessions = ws.sessions.where((s) => !s.archived).length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          // 左：副标题 + 主标题
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'AI Workbench · 今日 $activeSessions 个活动会话',
                  style: theme.bodySmall?.copyWith(fontSize: 12),
                ),
                const SizedBox(height: 2),
                const Text(
                  '工作台',
                  style: TextStyle(
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
          // 右：设备切换器按钮
          _DeviceSwitcherButton(ws: ws),
        ],
      ),
    );
  }
}

// 设备切换器按钮：AppCard 内嵌 monitor 图标 + 设备名 + 下拉箭头
class _DeviceSwitcherButton extends StatelessWidget {
  const _DeviceSwitcherButton({required this.ws});

  final WorkspaceController ws;

  @override
  Widget build(BuildContext context) {
    final device = ws.selectedDevice;
    final label = device == null ? '选择设备' : device.name;
    return AppCard(
      onTap: () => _showDeviceSwitcher(context, ws),
      borderRadius: AppRadius.lg,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.monitor, size: 18, color: AppColors.primary),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 90),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 13,
                color: AppColors.secondary,
              ),
            ),
          ),
          const Icon(Icons.arrow_drop_down, color: AppColors.muted),
        ],
      ),
    );
  }
}

class _DashboardDeviceRow extends StatefulWidget {
  const _DashboardDeviceRow({required this.device, required this.compact});

  final DesktopDevice device;
  final bool compact;

  @override
  State<_DashboardDeviceRow> createState() => _DashboardDeviceRowState();
}

class _DashboardDeviceRowState extends State<_DashboardDeviceRow> {
  bool _switching = false;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    final device = widget.device;
    final selected = ws.selectedDevice?.id == device.id;
    return InkWell(
      onTap: _switching ? null : () => _selectDevice(context, ws),
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: 16,
          vertical: widget.compact ? 12 : 14,
        ),
        child: Row(
          children: [
            AppIconBox(
              icon: Icons.desktop_windows_outlined,
              size: widget.compact ? 34 : 40,
              iconSize: widget.compact ? 17 : 20,
              borderRadius: 10,
              background:
                  device.online ? AppColors.successSoft : AppColors.surfaceMuted,
              foreground:
                  device.online ? AppColors.successDeep : AppColors.secondary,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    device.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: AppColors.ink,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    '${device.os} · ${device.online ? '在线' : '离线'}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: AppColors.muted),
                  ),
                ],
              ),
            ),
            if (_switching)
              const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else if (selected)
              const Icon(Icons.check_circle, size: 20, color: AppColors.primary)
            else
              const Icon(Icons.chevron_right, size: 18, color: AppColors.muted),
          ],
        ),
      ),
    );
  }

  Future<void> _selectDevice(BuildContext context, WorkspaceController ws) async {
    if (ws.selectedDevice?.id == widget.device.id) {
      Navigator.of(context).maybePop();
      return;
    }
    setState(() => _switching = true);
    try {
      await ws.selectDevice(widget.device);
      if (context.mounted) Navigator.of(context).maybePop();
    } finally {
      if (mounted) setState(() => _switching = false);
    }
  }
}

Future<void> _showDeviceSwitcher(
    BuildContext context, WorkspaceController ws) async {
  await ws.loadDevices();
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => WorkspaceScope(
      controller: ws,
      child: SafeArea(
        child: AnimatedBuilder(
          animation: ws,
          builder: (context, _) => ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
            children: [
              const Text(
                '切换桌面设备',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                  color: AppColors.ink,
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              if (ws.devices.isEmpty)
                const SizedBox(
                  height: 180,
                  child: EmptyState('还没有桌面设备。请在桌面端使用同一账号登录。'),
                )
              else
                AppCard(
                  borderRadius: AppRadius.xl,
                  padding: EdgeInsets.zero,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(AppRadius.xl),
                    child: Column(
                      children: [
                        for (int i = 0; i < ws.devices.length; i++) ...[
                          if (i > 0)
                            const Divider(
                              height: 1,
                              thickness: 1,
                              color: AppColors.divider,
                            ),
                          _DashboardDeviceRow(
                            device: ws.devices[i],
                            compact: true,
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    ),
  );
}

// Hero 卡片：纯色 AppColors.primary 背景 + 装饰圆 + 项目信息 + 状态徽章 + 竖线分隔统计
class _HeroCard extends StatelessWidget {
  const _HeroCard({required this.ws});

  final WorkspaceController ws;

  @override
  Widget build(BuildContext context) {
    final project = ws.projects.isNotEmpty ? ws.projects.first : null;
    final activeSessions = ws.sessions.where((s) => !s.archived).length;
    final installedProviders =
        ws.providerStatuses.where((p) => p.installed).length;
    // 注意：背景用纯色 AppColors.primary，不要用 heroGradient
    return AppCard(
      borderRadius: AppRadius.x2l,
      padding: const EdgeInsets.all(18),
      background: AppColors.primary,
      borderColor: Colors.transparent,
      shadow: const [],
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          // 装饰圆（半透明主色）
          Positioned(
            top: -40,
            right: -40,
            child: Container(
              width: 136,
              height: 136,
              decoration: const BoxDecoration(
                color: AppColors.primaryMuted,
                shape: BoxShape.circle,
              ),
            ),
          ),
          // 内容
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '当前活动项目',
                          style: TextStyle(
                            fontSize: 12,
                            color: Colors.white.withOpacity(0.78),
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
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
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  // 40×40 圆形操作按钮
                  Container(
                    width: 40,
                    height: 40,
                    decoration: const BoxDecoration(
                      color: AppColors.primaryMuted,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.smart_toy_outlined,
                      color: Colors.white,
                      size: 20,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              // 状态徽章：自定义白色样式（bg white 0.16 + border white 0.22 + fg white）
              AppStatusBadge(
                project == null ? '待同步' : '运行中',
                style: AppStatusStyle(
                  Colors.white.withOpacity(0.16),
                  Colors.white,
                  Colors.white.withOpacity(0.22),
                ),
              ),
              const SizedBox(height: 14),
              // 统计区：竖线分隔，无卡片背景
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: _HeroStatColumn(
                      value: '${ws.projects.length}',
                      label: '项目',
                    ),
                  ),
                  Container(
                    width: 1,
                    height: 28,
                    color: Colors.white.withOpacity(0.18),
                  ),
                  Expanded(
                    child: _HeroStatColumn(
                      value: '$activeSessions',
                      label: '活跃会话',
                    ),
                  ),
                  Container(
                    width: 1,
                    height: 28,
                    color: Colors.white.withOpacity(0.18),
                  ),
                  Expanded(
                    child: _HeroStatColumn(
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
        ],
      ),
    );
  }
}

// Hero 统计列：仅文本，无背景卡片（取代旧版 _HeroStat）
class _HeroStatColumn extends StatelessWidget {
  const _HeroStatColumn({
    required this.value,
    required this.label,
    this.onTap,
  });

  final String value;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final content = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(
        children: [
          Text(value,
              style: const TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w800,
                color: Colors.white,
              )),
          const SizedBox(height: 2),
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
        child: content,
      ),
    );
  }
}

// 快捷操作：2 列 grid，gap 10，每个 AppCard 横向 Row 布局
class _QuickActions extends StatelessWidget {
  const _QuickActions({required this.ws, this.onNavigate});

  final WorkspaceController ws;
  final void Function(int)? onNavigate;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: _QuickActionButton(
            icon: Icons.add,
            label: '新建会话',
            background: AppColors.primarySoftSolid,
            foreground: AppColors.primary,
            onTap: onNavigate == null ? null : () => onNavigate!(1),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _QuickActionButton(
            icon: Icons.sync,
            label: '同步项目',
            background: AppColors.infoSoft,
            foreground: AppColors.info,
            onTap: ws.refreshWorkspace,
          ),
        ),
      ],
    );
  }
}

class _QuickActionButton extends StatelessWidget {
  const _QuickActionButton({
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

  @override
  Widget build(BuildContext context) {
    return AppCard(
      onTap: onTap,
      borderRadius: AppRadius.lg,
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          // 40×40 圆形图标方框
          AppIconBox(
            icon: icon,
            size: 40,
            iconSize: 18,
            borderRadius: AppRadius.full,
            background: background,
            foreground: foreground,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: AppColors.ink,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// 项目概览卡：项目图标 + 名称 + 3 列统计（文件变更 / 分支 / 同步率）
class _ProjectOverview extends StatelessWidget {
  const _ProjectOverview({required this.ws});

  final WorkspaceController ws;

  @override
  Widget build(BuildContext context) {
    if (ws.projects.isEmpty) {
      return AppCard(
        borderRadius: AppRadius.lg,
        child: Row(
          children: [
            AppIconBox(
              icon: Icons.folder_outlined,
              size: 28,
              iconSize: 16,
              borderRadius: AppRadius.sm,
              background: AppColors.primarySoftSolid,
              foreground: AppColors.primary,
            ),
            const SizedBox(width: 10),
            const Expanded(
              child: Text(
                '还没有同步项目',
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: AppColors.secondary,
                ),
              ),
            ),
          ],
        ),
      );
    }
    final project = ws.projects.first;
    return AppCard(
      borderRadius: AppRadius.lg,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              AppIconBox(
                icon: Icons.folder_outlined,
                size: 28,
                iconSize: 16,
                borderRadius: AppRadius.sm,
                background: AppColors.primarySoftSolid,
                foreground: AppColors.primary,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  project.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: AppColors.ink,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: _OverviewStat(
                  label: '文件变更',
                  value: project.gitDirty ? '有' : '无',
                ),
              ),
              Expanded(
                child: _OverviewStat(
                  label: '分支',
                  value: project.gitBranch ?? 'main',
                ),
              ),
              Expanded(
                child: _OverviewStat(
                  label: '同步率',
                  value: project.gitDirty ? '90%' : '100%',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// 项目概览的统计列
class _OverviewStat extends StatelessWidget {
  const _OverviewStat({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w700,
            color: AppColors.ink,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          label,
          style: const TextStyle(fontSize: 11, color: AppColors.muted),
        ),
      ],
    );
  }
}

// ===========================================================================
// 项目 tab
// ===========================================================================
class _ProjectsTab extends StatefulWidget {
  const _ProjectsTab();

  @override
  State<_ProjectsTab> createState() => _ProjectsTabState();
}

class _ProjectsTabState extends State<_ProjectsTab> {
  String? _expandedProjectId;

  void _toggleProject(String projectId) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      setState(() {
        _expandedProjectId = _expandedProjectId == projectId ? null : projectId;
      });
    });
  }

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
                  child: EmptyState(
                    '还没有项目',
                    icon: Icons.folder_outlined,
                  ),
                )
              else
                ...ws.projects.map((project) => Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: _ProjectCard(
                        project: project,
                        ws: ws,
                        expanded: _expandedProjectId == project.id,
                        onToggle: () => _toggleProject(project.id),
                      ),
                    )),
            ],
          ),
        ),
      ),
    );
  }
}

// 项目卡（保持原有结构，使用 AppCard + AppIconBox + AppStatusBadge）
class _ProjectCard extends StatelessWidget {
  const _ProjectCard({
    required this.project,
    required this.ws,
    required this.expanded,
    required this.onToggle,
  });

  final WorkspaceProject project;
  final WorkspaceController ws;
  final bool expanded;
  final VoidCallback onToggle;

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
                  IconButton(
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => WorkspaceScope(
                          controller: ws,
                          child: const ProvidersPage(),
                        ),
                      ),
                    ),
                    icon: const Icon(
                      Icons.smart_toy_outlined,
                      color: AppColors.primary,
                    ),
                    visualDensity: VisualDensity.compact,
                    tooltip: 'AI 工具',
                  ),
                  // 新建 AI 会话
                  IconButton(
                    onPressed: () => _showProviderSelector(context, ws, project),
                    icon: const Icon(Icons.add, color: AppColors.primary),
                    visualDensity: VisualDensity.compact,
                    tooltip: '新建 AI 会话',
                  ),
                  IconButton(
                    onPressed: onToggle,
                    icon: Icon(
                      expanded ? Icons.expand_less : Icons.expand_more,
                      color: AppColors.muted,
                    ),
                    visualDensity: VisualDensity.compact,
                    tooltip: expanded ? '收起会话' : '展开会话',
                  ),
                ],
              ),
            ),
            if (expanded) ...[
              const Divider(height: 1, thickness: 1, color: AppColors.divider),
              if (sessions.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 16, vertical: 20),
                  child: Text(
                    '这个项目还没有会话。',
                    style: TextStyle(fontSize: 12, color: AppColors.muted),
                  ),
                )
              else
                for (int i = 0; i < sessions.length; i++) ...[
                  if (i > 0)
                    const Divider(
                      height: 1,
                      thickness: 1,
                      color: AppColors.divider,
                    ),
                  _ProjectSessionRow(sessionId: sessions[i].id),
                ],
            ],
          ],
        ),
      ),
    );
  }
}

class _ProjectSessionRow extends StatelessWidget {
  const _ProjectSessionRow({required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    final session = ws.sessions.firstWhere((item) => item.id == sessionId);
    return InkWell(
      onTap: () => _openSessionById(context, ws, sessionId),
      onLongPress: () => _showSessionMenuById(context, ws, sessionId),
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
                      color: AppColors.ink,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${session.providerId} · ${_sessionStatusLabel(session.status)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: AppColors.muted),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              _shortTime(session.updatedAt),
              style: const TextStyle(fontSize: 11, color: AppColors.muted),
            ),
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
        // 高 62 padding 14（横向 14，纵向 11 以贴近设计目标高度）
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: _SessionTileBody(sessionId: sessionId),
      ),
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
        // 40×40 圆形 surfaceMuted 图标方框
        AppIconBox(
          icon: _providerIcon(session.providerId),
          size: 40,
          iconSize: 20,
          borderRadius: AppRadius.full,
          background: AppColors.surfaceMuted,
          foreground: AppColors.primary,
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
  if (runStatus != null) {
    return (_sessionStatusStyle(runStatus), _sessionStatusLabel(runStatus));
  }
  return (
    _sessionStatusStyle(session.status),
    _sessionStatusLabel(session.status),
  );
}

String _sessionStatusLabel(String status) {
  switch (status.trim().toLowerCase()) {
    case '':
    case 'idle':
      return '空闲';
    case 'running':
    case 'active':
      return '运行中';
    case 'created':
    case 'pending':
    case 'queued':
      return '待处理';
    case 'completed':
    case 'complete':
    case 'success':
    case 'done':
      return '已完成';
    case 'failed':
    case 'failure':
    case 'error':
      return '失败';
    case 'exited':
      return '已退出';
    default:
      return status;
  }
}

AppStatusStyle _sessionStatusStyle(String status) {
  switch (status.trim().toLowerCase()) {
    case 'running':
    case 'active':
      return AppStatusStyle.primary;
    case 'completed':
    case 'complete':
    case 'success':
    case 'done':
      return AppStatusStyle.success;
    case 'failed':
    case 'failure':
    case 'error':
      return AppStatusStyle.danger;
    case 'created':
    case 'pending':
    case 'queued':
      return AppStatusStyle.info;
    default:
      return AppStatusStyle.neutral;
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
