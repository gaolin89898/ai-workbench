import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';

class DeviceManagementPage extends StatefulWidget {
  const DeviceManagementPage({super.key});

  @override
  State<DeviceManagementPage> createState() => _DeviceManagementPageState();
}

class _DeviceManagementPageState extends State<DeviceManagementPage> {
  final Set<String> _busyDeviceIds = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        WorkspaceScope.of(context).loadDevices();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) {
        final devices = ws.devices;
        return Scaffold(
          backgroundColor: AppColors.background,
          appBar: AppBar(
            title: const Text('设备管理'),
            centerTitle: true,
            actions: [
              IconButton(
                tooltip: '刷新',
                icon: ws.loading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.refresh),
                onPressed: ws.loading ? null : ws.loadDevices,
              ),
            ],
          ),
          body: RefreshIndicator(
            onRefresh: ws.loadDevices,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg,
                AppSpacing.md,
                AppSpacing.lg,
                AppSpacing.x3l,
              ),
              children: [
                if (ws.error != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.md),
                    child: Text(
                      ws.error!,
                      style: const TextStyle(
                        color: AppColors.danger,
                        fontSize: 12,
                      ),
                    ),
                  ),
                if (devices.isEmpty)
                  EmptyState(
                    ws.loading ? '正在读取设备...' : '暂无已绑定设备',
                    icon: Icons.desktop_windows_outlined,
                  )
                else ...[
                  AppSectionTitle(
                    '已绑定设备',
                    trailing: Text(
                      '${devices.length} 台',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  for (final device in devices)
                    Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.md),
                      child: _ManagedDeviceCard(
                        device: device,
                        selected: ws.selectedDevice?.id == device.id,
                        busy: _busyDeviceIds.contains(device.id),
                        onRename: () => _renameDevice(device),
                        onDelete: () => _deleteDevice(device),
                      ),
                    ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _renameDevice(DesktopDevice device) async {
    if (_busyDeviceIds.contains(device.id)) return;
    final controller = TextEditingController(text: device.name);
    final nextName = await showDialog<String>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('编辑设备名称'),
          content: TextField(
            controller: controller,
            autofocus: true,
            textInputAction: TextInputAction.done,
            maxLength: 40,
            decoration: const InputDecoration(
              labelText: '设备名称',
              hintText: '输入新的设备名称',
            ),
            onSubmitted: (value) {
              final trimmed = value.trim();
              if (trimmed.isNotEmpty) {
                Navigator.of(context).pop(trimmed);
              }
            },
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () {
                final trimmed = controller.text.trim();
                if (trimmed.isEmpty) return;
                Navigator.of(context).pop(trimmed);
              },
              child: const Text('保存'),
            ),
          ],
        );
      },
    );
    controller.dispose();
    if (nextName == null || nextName == device.name) return;
    if (!mounted) return;

    final ws = WorkspaceScope.of(context);
    setState(() => _busyDeviceIds.add(device.id));
    final updated = await ws.renameDevice(device, name: nextName);
    if (!mounted) return;
    setState(() => _busyDeviceIds.remove(device.id));
    _showSnack(updated == null ? '设备名称保存失败' : '设备名称已更新');
  }

  Future<void> _deleteDevice(DesktopDevice device) async {
    if (_busyDeviceIds.contains(device.id)) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除此设备？'),
        content: Text(
          '删除后，${device.name} 将从当前账户移除，相关会话、项目和状态数据也会一并删除。此操作不可撤销。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: AppColors.danger,
              foregroundColor: AppColors.inverse,
            ),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    if (!mounted) return;

    final ws = WorkspaceScope.of(context);
    setState(() => _busyDeviceIds.add(device.id));
    final deleted = await ws.deleteDevice(device);
    if (!mounted) return;
    setState(() => _busyDeviceIds.remove(device.id));
    _showSnack(deleted ? '设备已删除' : '设备删除失败');
  }

  void _showSnack(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }
}

class _ManagedDeviceCard extends StatelessWidget {
  const _ManagedDeviceCard({
    required this.device,
    required this.selected,
    required this.busy,
    required this.onRename,
    required this.onDelete,
  });

  final DesktopDevice device;
  final bool selected;
  final bool busy;
  final VoidCallback onRename;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final statusStyle =
        device.online ? AppStatusStyle.success : AppStatusStyle.neutral;
    final statusText = device.online ? '在线' : '离线';
    return AppCard(
      borderRadius: AppRadius.lg,
      borderColor: selected ? AppColors.primarySoftSolid2 : AppColors.border,
      background: selected ? AppColors.primarySoftSolid : AppColors.surface,
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppIconBox(
            icon: Icons.desktop_windows,
            size: 40,
            iconSize: 20,
            borderRadius: AppRadius.xl,
            background:
                device.online ? AppColors.successSoft : AppColors.surfaceMuted,
            foreground: device.online ? AppColors.successDeep : AppColors.muted,
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        device.name,
                        style: Theme.of(context).textTheme.titleMedium,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    AppStatusBadge(statusText, style: statusStyle),
                  ],
                ),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  '${device.os} · ${_lastSeenText(device.lastSeenAt)}',
                  style: Theme.of(context).textTheme.bodySmall,
                  overflow: TextOverflow.ellipsis,
                ),
                if (selected) ...[
                  const SizedBox(height: AppSpacing.xs),
                  const Text(
                    '当前使用中',
                    style: TextStyle(fontSize: 11, color: AppColors.primary),
                  ),
                ],
                const SizedBox(height: AppSpacing.md),
                Row(
                  children: [
                    OutlinedButton.icon(
                      onPressed: busy ? null : onRename,
                      icon: const Icon(Icons.edit_outlined, size: 16),
                      label: const Text('编辑'),
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(0, 36),
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    TextButton.icon(
                      onPressed: busy ? null : onDelete,
                      icon: busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.delete_outline, size: 16),
                      label: const Text('删除'),
                      style: TextButton.styleFrom(
                        foregroundColor: AppColors.danger,
                        minimumSize: const Size(0, 36),
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _lastSeenText(String? value) {
    if (device.online) return '当前在线';
    if (value == null || value.isEmpty) return '从未在线';
    final seenAt = DateTime.tryParse(value)?.toLocal();
    if (seenAt == null) return '最后在线时间未知';
    final diff = DateTime.now().difference(seenAt);
    if (diff.inMinutes < 1) return '刚刚在线';
    if (diff.inHours < 1) return '${diff.inMinutes} 分钟前在线';
    if (diff.inDays < 1) return '${diff.inHours} 小时前在线';
    if (diff.inDays < 30) return '${diff.inDays} 天前在线';
    return '${seenAt.year}-${_two(seenAt.month)}-${_two(seenAt.day)} 在线';
  }

  String _two(int value) => value.toString().padLeft(2, '0');
}
