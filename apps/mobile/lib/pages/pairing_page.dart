import 'package:flutter/material.dart';

import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';

class PairingPage extends StatefulWidget {
  const PairingPage({super.key});

  @override
  State<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends State<PairingPage> {
  final TextEditingController _desktopServerController =
      TextEditingController();
  final TextEditingController _desktopCodeController = TextEditingController();
  String? _code;
  String? _expiresAt;
  String? _error;
  String? _scanResult;
  bool _loading = false;
  bool _approving = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_desktopServerController.text.isEmpty) {
      _desktopServerController.text = WorkspaceScope.of(context).api.baseUrl;
    }
  }

  @override
  void dispose() {
    _desktopServerController.dispose();
    _desktopCodeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('配对桌面')),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          // ---- 提示卡 ----
          const AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '配对桌面',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: AppColors.ink,
                  ),
                ),
                SizedBox(height: AppSpacing.sm),
                Text(
                  '输入桌面端显示的服务器地址和配对码完成连接。',
                  style: TextStyle(
                    fontSize: 13,
                    color: AppColors.secondary,
                    height: 1.55,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          // ---- 手动配对卡 ----
          AppCard(
            borderRadius: AppRadius.xl,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  '手动输入',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: AppColors.ink,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                const Text(
                  '填写桌面端的服务器地址和配对码。',
                  style: TextStyle(
                    fontSize: 13,
                    color: AppColors.secondary,
                    height: 1.55,
                  ),
                ),
                if (_scanResult != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    _scanResult!,
                    style: TextStyle(
                      fontSize: 13,
                      color: _scanResult!.contains('失败') ||
                              _scanResult!.contains('无效')
                          ? AppColors.danger
                          : AppColors.success,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
                const SizedBox(height: 14),
                TextField(
                  controller: _desktopServerController,
                  decoration: const InputDecoration(
                    labelText: '服务器地址',
                    hintText: 'http://8.162.12.148:3000',
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _desktopCodeController,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(
                    labelText: '桌面配对码',
                  ),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: _approving ? null : _approveTypedDesktopCode,
                  icon: const Icon(Icons.check),
                  label: const Text('确认配对'),
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          // ---- 短码卡 ----
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  _code ?? '未生成',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 34,
                    fontWeight: FontWeight.w900,
                    color: AppColors.ink,
                    letterSpacing: 8,
                  ),
                ),
                if (_expiresAt != null) ...[
                  const SizedBox(height: AppSpacing.sm),
                  Text(
                    '过期时间：$_expiresAt',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.muted,
                    ),
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: AppSpacing.md),
                  Text(
                    _error!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 13,
                      color: AppColors.danger,
                    ),
                  ),
                ],
                const SizedBox(height: AppSpacing.lg),
                FilledButton(
                  onPressed: _loading ? null : _create,
                  child: Text(_loading ? '生成中...' : '重新生成'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _create() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final pairingCode =
          await WorkspaceScope.of(context).api.createPairingCode();
      if (!mounted) return;
      setState(() {
        _code = pairingCode.code;
        _expiresAt = pairingCode.expiresAt;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _approveTypedDesktopCode() async {
    final serverUrl = _desktopServerController.text.trim();
    final code = _desktopCodeController.text.trim().toUpperCase();
    if (serverUrl.isEmpty || code.isEmpty) {
      setState(() => _scanResult = '请填写服务器地址和桌面配对码。');
      return;
    }
    await _approveDesktopPairing(serverUrl: serverUrl, code: code);
  }

  Future<void> _approveDesktopPairing({
    required String serverUrl,
    required String code,
  }) async {
    final ws = WorkspaceScope.of(context);
    setState(() {
      _approving = true;
      _scanResult = null;
      _error = null;
    });
    try {
      await ws.api.approveDesktopPairing(
        serverUrl: serverUrl,
        code: code,
      );
      await ws.loadDevices();
      if (!mounted) return;
      setState(() => _scanResult = '已确认配对，桌面端会自动完成保存。');
    } catch (error) {
      if (!mounted) return;
      setState(() => _scanResult = '配对失败：$error');
    } finally {
      if (mounted) {
        setState(() => _approving = false);
      }
    }
  }
}

