import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_controller.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'mobile_shell_page.dart';
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
    // 2 个 tab：设备 / 设置
    final pages = const [
      _DeviceListTab(),
      SettingsPage(),
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
              icon: Icon(Icons.settings_outlined),
              selectedIcon: Icon(Icons.settings),
              label: '设置'),
        ],
      ),
    );
  }
}

// 设备 tab
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

// 设备卡
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
    final device = widget.device;
    return AppCard(
      onTap: _opening ? null : () => _openDevice(context, ws),
      child: Row(
        children: [
          // 设备图标（success soft 配色）
          AppIconBox(
            icon: Icons.desktop_windows,
            size: 40,
            iconSize: 20,
            borderRadius: 10,
            background: AppColors.successSoft,
            foreground: AppColors.successDeep,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(device.name,
                    style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        color: AppColors.ink)),
                const SizedBox(height: 4),
                Text(
                  '${device.os} · ${device.online ? '在线' : '离线'}',
                  style: const TextStyle(color: AppColors.muted, fontSize: 12),
                ),
              ],
            ),
          ),
          // trailing：连接中 -> spinner；在线 -> check_circle；离线 -> chevron_right
          if (_opening)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else if (device.online)
            const Icon(Icons.check_circle, color: AppColors.success)
          else
            const Icon(Icons.chevron_right, color: AppColors.muted),
        ],
      ),
    );
  }

  Future<void> _openDevice(BuildContext context, WorkspaceController ws) async {
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
