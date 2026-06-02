import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'mobile_shell_page.dart';
import 'pairing_page.dart';

class DeviceListPage extends StatelessWidget {
  const DeviceListPage({super.key});

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: const Text('桌面设备'),
          actions: [
            IconButton(
                onPressed: ws.loadDevices, icon: const Icon(Icons.refresh)),
            IconButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => WorkspaceScope(
                    controller: ws,
                    child: const PairingPage(),
                  ),
                ),
              ),
              icon: const Icon(Icons.link),
            ),
          ],
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
                    child: EmptyState('还没有配对桌面。先在右上角生成配对码，再到桌面端配对。'))
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

class _DeviceCard extends StatelessWidget {
  const _DeviceCard({required this.device});

  final DesktopDevice device;

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AppCard(
      onTap: () async {
        await ws.selectDevice(device);
        if (!context.mounted) return;
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => WorkspaceScope(
              controller: ws,
              child: const MobileShellPage(),
            ),
          ),
        );
      },
      child: Row(
        children: [
          Icon(Icons.desktop_windows,
              color: device.online ? AppColors.success : AppColors.muted),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(device.name,
                    style: const TextStyle(
                        fontWeight: FontWeight.w900, fontSize: 16)),
                const SizedBox(height: 4),
                Text(
                  '${device.os} · ${device.online ? '在线' : '离线'}',
                  style: const TextStyle(color: AppColors.muted, fontSize: 12),
                ),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: AppColors.muted),
        ],
      ),
    );
  }
}
