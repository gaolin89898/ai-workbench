import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_controller.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'mobile_shell_page.dart';
import 'settings_page.dart';

/// 设备选择页。
///
/// 从原来的「设备 / 设置」2 tab 结构重做为单页「选择设备」：
/// 顶部引导 + 状态概览胶囊 + 可连接/不可用分组 + 空状态卡 + 帮助 footer。
class DeviceListPage extends StatefulWidget {
  const DeviceListPage({super.key});

  @override
  State<DeviceListPage> createState() => _DeviceListPageState();
}

class _DeviceListPageState extends State<DeviceListPage> {
  // 正在连接中的设备 ID 集合。对应原 _DeviceCard 里的 _opening 状态，
  // 上提到页面级以便状态概览胶囊能统计「连接中」数量。
  final Set<String> _connectingIds = {};

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) {
        final devices = ws.devices;
        // 按在线 / 离线分组
        final onlineDevices = devices.where((d) => d.online).toList();
        final offlineDevices = devices.where((d) => !d.online).toList();
        final onlineCount = onlineDevices.length;
        final connectingCount = _connectingIds.length;
        final offlineCount = offlineDevices.length;

        return Scaffold(
          backgroundColor: AppColors.background,
          // sticky header：返回按钮 + 标题「选择设备」+ 刷新按钮
          appBar: AppBar(
            leading: IconButton(
              icon: const Icon(Icons.arrow_back),
              tooltip: '返回',
              onPressed: () => Navigator.maybePop(context),
            ),
            title: const Text('选择设备'),
            centerTitle: true,
            actions: [
              // 刷新按钮：加载中显示小 spinner，避免重复点击
              IconButton(
                tooltip: '刷新',
                icon: ws.loading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.refresh),
                onPressed: ws.loading ? null : () => ws.loadDevices(),
              ),
            ],
          ),
          body: RefreshIndicator(
            onRefresh: ws.loadDevices,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg, AppSpacing.md, AppSpacing.lg, AppSpacing.x3l),
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                // 错误提示（保留原逻辑）
                if (ws.error != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.md),
                    child: Text(
                      ws.error!,
                      style: const TextStyle(
                          color: AppColors.danger, fontSize: 12),
                    ),
                  ),
                // 引导卡
                const _GuideCard(),
                const SizedBox(height: AppSpacing.md),
                // 状态概览胶囊
                _StatusOverviewRow(
                  onlineCount: onlineCount,
                  connectingCount: connectingCount,
                  offlineCount: offlineCount,
                ),
                // 设备列表 / 空状态卡
                if (devices.isEmpty) ...[
                  const SizedBox(height: AppSpacing.lg),
                  _EmptyDeviceCard(onRefresh: ws.loadDevices),
                ] else ...[
                  if (onlineDevices.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.xl),
                    AppSectionTitle(
                      '可连接',
                      trailing: Text(
                        '$onlineCount 台',
                        style: const TextStyle(
                            fontSize: 11, color: AppColors.muted),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    ...onlineDevices.map((device) => Padding(
                          padding:
                              const EdgeInsets.only(bottom: AppSpacing.md),
                          child: _DeviceCard(
                            device: device,
                            isConnecting:
                                _connectingIds.contains(device.id),
                            onTap: () => _openDevice(device),
                          ),
                        )),
                  ],
                  if (offlineDevices.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.xl),
                    AppSectionTitle(
                      '不可用',
                      trailing: Text(
                        '$offlineCount 台',
                        style: const TextStyle(
                            fontSize: 11, color: AppColors.muted),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    ...offlineDevices.map((device) => Padding(
                          padding:
                              const EdgeInsets.only(bottom: AppSpacing.md),
                          child: _OfflineDeviceCard(device: device),
                        )),
                  ],
                ],
                // 帮助 footer
                const SizedBox(height: AppSpacing.lg),
                _HelpFooter(onGoSettings: _goSettings),
              ],
            ),
          ),
        );
      },
    );
  }

  /// 打开设备：选择设备并跳转到工作台。
  /// 保留原 _DeviceCard._openDevice 的业务逻辑（selectDevice + refreshWorkspace
  /// 由 selectDevice 内部触发，随后 push MobileShellPage）。
  Future<void> _openDevice(DesktopDevice device) async {
    if (_connectingIds.contains(device.id)) return;
    final ws = WorkspaceScope.of(context);
    setState(() => _connectingIds.add(device.id));
    try {
      await ws.selectDevice(device);
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => WorkspaceScope(
            controller: ws,
            child: const MobileShellPage(),
          ),
        ),
      );
    } finally {
      if (mounted) {
        setState(() => _connectingIds.remove(device.id));
      }
    }
  }

  /// 跳转设置页
  void _goSettings() {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const SettingsPage()),
    );
  }
}

/// 引导卡：图标 + 标题「选择要连接的桌面端」+ 副标题
class _GuideCard extends StatelessWidget {
  const _GuideCard();

  @override
  Widget build(BuildContext context) {
    return AppCard(
      borderRadius: AppRadius.lg,
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 44×44 primarySoftSolid 软色图标盒
          AppIconBox(
            icon: Icons.phonelink,
            size: 44,
            iconSize: 22,
            borderRadius: AppRadius.xl,
            background: AppColors.primarySoftSolid,
            foreground: AppColors.primary,
            border: AppColors.primarySoftSolid2,
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: const [
                Text(
                  '选择要连接的桌面端',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: AppColors.ink,
                  ),
                ),
                SizedBox(height: AppSpacing.xs),
                Text(
                  '仅显示已配对的设备',
                  style: TextStyle(fontSize: 12, color: AppColors.muted),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 状态概览胶囊行：在线 / 连接中 / 离线 数量
class _StatusOverviewRow extends StatelessWidget {
  const _StatusOverviewRow({
    required this.onlineCount,
    required this.connectingCount,
    required this.offlineCount,
  });

  final int onlineCount;
  final int connectingCount;
  final int offlineCount;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        AppStatusBadge(
          '$onlineCount 台在线',
          style: AppStatusStyle.success,
          dot: true,
        ),
        const SizedBox(width: AppSpacing.sm),
        AppStatusBadge(
          '$connectingCount 台连接中',
          style: AppStatusStyle.info,
        ),
        const SizedBox(width: AppSpacing.sm),
        AppStatusBadge(
          '$offlineCount 台离线',
          style: AppStatusStyle.neutral,
        ),
      ],
    );
  }
}

/// 在线 / 连接中 设备卡
class _DeviceCard extends StatelessWidget {
  const _DeviceCard({
    required this.device,
    required this.isConnecting,
    required this.onTap,
  });

  final DesktopDevice device;
  final bool isConnecting;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    if (isConnecting) {
      // 连接中样式：primarySoftSolid 背景 + 旋转 loader
      return AppCard(
        borderRadius: AppRadius.lg,
        background: AppColors.primarySoftSolid,
        borderColor: AppColors.primarySoftSolid2,
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Row(
          children: [
            // 连接中图标盒：用 CircularProgressIndicator 代替静态图标
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(AppRadius.xl),
                border: Border.all(color: AppColors.primarySoftSolid2),
              ),
              alignment: Alignment.center,
              child: const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: AppColors.primary,
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    device.name,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: AppColors.ink,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  const Text(
                    '连接中...',
                    style: TextStyle(fontSize: 12, color: AppColors.primary),
                  ),
                ],
              ),
            ),
            // 右侧 spinner
            const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ],
        ),
      );
    }

    // 在线样式：可点击跳转
    return AppCard(
      borderRadius: AppRadius.lg,
      borderColor: AppColors.primarySoftSolid2,
      padding: const EdgeInsets.all(AppSpacing.md),
      onTap: onTap,
      child: Row(
        children: [
          // successSoft 软色图标盒
          AppIconBox(
            icon: Icons.desktop_windows,
            size: 40,
            iconSize: 20,
            borderRadius: AppRadius.xl,
            background: AppColors.successSoft,
            foreground: AppColors.successDeep,
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  device.name,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: AppColors.ink,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  '${device.os} · 在线',
                  style: const TextStyle(
                      fontSize: 12, color: AppColors.muted),
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          const AppStatusBadge('在线', style: AppStatusStyle.success),
          const Icon(Icons.chevron_right, color: AppColors.muted, size: 20),
        ],
      ),
    );
  }
}

/// 离线设备卡：opacity 0.72 表示不可用
class _OfflineDeviceCard extends StatelessWidget {
  const _OfflineDeviceCard({required this.device});

  final DesktopDevice device;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: 0.72,
      child: AppCard(
        borderRadius: AppRadius.lg,
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Row(
          children: [
            // surfaceMuted 灰色图标盒
            AppIconBox(
              icon: Icons.desktop_windows,
              size: 40,
              iconSize: 20,
              borderRadius: AppRadius.xl,
              background: AppColors.surfaceMuted,
              foreground: AppColors.muted,
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    device.name,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: AppColors.muted,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    '${device.os} · 离线',
                    style: const TextStyle(
                        fontSize: 12, color: AppColors.muted),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            const Text(
              '离线',
              style: TextStyle(fontSize: 11, color: AppColors.muted),
            ),
          ],
        ),
      ),
    );
  }
}

/// 空状态卡：未发现设备时展示
class _EmptyDeviceCard extends StatelessWidget {
  const _EmptyDeviceCard({required this.onRefresh});

  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      borderRadius: AppRadius.lg,
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 圆形 primarySoftSolid 图标盒
          AppIconBox(
            icon: Icons.radar,
            size: 40,
            iconSize: 20,
            borderRadius: AppRadius.full,
            background: AppColors.primarySoftSolid,
            foreground: AppColors.primary,
          ),
          const SizedBox(height: AppSpacing.md),
          const Text(
            '没有找到设备',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: AppColors.ink,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          const Text(
            '请确认桌面端已启动并联网',
            style: TextStyle(
                fontSize: 12, color: AppColors.muted, height: 1.5),
          ),
          const SizedBox(height: AppSpacing.lg),
          Row(
            children: [
              FilledButton(
                onPressed: () => onRefresh(),
                child: const Text('重新扫描'),
              ),
              const SizedBox(width: AppSpacing.sm),
              OutlinedButton(
                onPressed: () {},
                child: const Text('查看帮助'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 帮助 footer：设备未显示提示 + 去设置入口
class _HelpFooter extends StatelessWidget {
  const _HelpFooter({required this.onGoSettings});

  final VoidCallback onGoSettings;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      borderRadius: AppRadius.lg,
      padding: const EdgeInsets.all(AppSpacing.md),
      background: AppColors.surfaceMuted,
      borderColor: AppColors.border,
      child: Row(
        children: [
          const Icon(Icons.help_outline, size: 16, color: AppColors.muted),
          const SizedBox(width: AppSpacing.sm),
          const Expanded(
            child: Text(
              '设备未显示？',
              style: TextStyle(fontSize: 12, color: AppColors.secondary),
            ),
          ),
          TextButton(
            onPressed: onGoSettings,
            child: const Text(
              '去设置',
              style: TextStyle(fontSize: 12, color: AppColors.primary),
            ),
          ),
        ],
      ),
    );
  }
}
