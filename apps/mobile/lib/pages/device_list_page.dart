import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'mobile_shell_page.dart';
import 'providers_page.dart';
import 'settings_page.dart';

class DeviceListPage extends StatefulWidget {
  const DeviceListPage({super.key});

  @override
  State<DeviceListPage> createState() => _DeviceListPageState();
}

class _DeviceListPageState extends State<DeviceListPage> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      const _DeviceListTab(),
      const ProvidersPage(),
      const SettingsPage(),
    ];
    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (value) => setState(() => _index = value),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.desktop_windows_outlined),
              selectedIcon: Icon(Icons.desktop_windows),
              label: '设备'),
          NavigationDestination(
              icon: Icon(Icons.auto_awesome_outlined),
              selectedIcon: Icon(Icons.auto_awesome),
              label: 'AI 工具'),
          NavigationDestination(
              icon: Icon(Icons.settings_outlined),
              selectedIcon: Icon(Icons.settings),
              label: '设置'),
        ],
      ),
    );
  }
}

class _DeviceListTab extends StatelessWidget {
  const _DeviceListTab();

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: const Text('桌面设备'),
        ),
        body: RefreshIndicator(
          onRefresh: ws.loadDevices,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (ws.error != null)
                Text(ws.error!,
                    style: const TextStyle(color: AppColors.danger)),
              if (ws.devices.isEmpty)
                const SizedBox(
                    height: 360,
                    child: EmptyState('还没有桌面设备。请在桌面端使用同一账号登录，系统会自动绑定。'))
              else
                ...ws.devices.map((device) => Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: _DeviceCard(device: device),
                    )),
            ],
          ),
        ),
      ),
    );
  }
}

class _DeviceCard extends StatefulWidget {
  const _DeviceCard({required this.device});

  final DesktopDevice device;

  @override
  State<_DeviceCard> createState() => _DeviceCardState();
}

class _DeviceCardState extends State<_DeviceCard> {
  bool _opening = false;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AppCard(
      onTap: _opening ? null : () => _openDevice(context, ws),
      child: Row(
        children: [
          Icon(Icons.desktop_windows,
              color: widget.device.online ? AppColors.success : AppColors.muted),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(widget.device.name,
                    style: const TextStyle(
                        fontWeight: FontWeight.w900, fontSize: 16)),
                const SizedBox(height: 4),
                Text(
                  '${widget.device.os} · ${widget.device.online ? '在线' : '离线'}',
                  style: const TextStyle(color: AppColors.muted, fontSize: 12),
                ),
              ],
            ),
          ),
          if (_opening)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            const Icon(Icons.chevron_right, color: AppColors.muted),
        ],
      ),
    );
  }

  Future<void> _openDevice(BuildContext context, dynamic ws) async {
    if (_opening) return;
    setState(() => _opening = true);
    try {
      await ws.selectDevice(widget.device);
      if (!context.mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => WorkspaceScope(
            controller: ws,
            child: const MobileShellPage(),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }
}
