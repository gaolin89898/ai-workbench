import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

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
  bool _scanned = false;

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
                  '扫码配对',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: AppColors.ink,
                  ),
                ),
                SizedBox(height: AppSpacing.sm),
                Text(
                  '使用手机扫描桌面端显示的二维码',
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
          // ---- 扫码卡 ----
          AppCard(
            borderRadius: AppRadius.xl,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  '扫描二维码',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: AppColors.ink,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                const Text(
                  '识别后自动返回确认配对',
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
                FilledButton.icon(
                  onPressed: _approving ? null : _openScanner,
                  icon: const Icon(Icons.camera_alt),
                  label: Text(_approving ? '确认中...' : '扫码'),
                ),
                const SizedBox(height: 14),
                const Divider(height: 1),
                const SizedBox(height: 14),
                const Text(
                  '或手动输入',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: AppColors.ink,
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _desktopServerController,
                  decoration: const InputDecoration(
                    labelText: '服务器地址',
                    hintText: 'http://192.168.2.7:8081',
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

  Future<void> _openScanner() async {
    _scanned = false;
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => WorkspaceScope(
          controller: WorkspaceScope.of(context),
          child: _DesktopPairingScanner(
            onDetected: (value) async {
              if (_scanned) return;
              _scanned = true;
              Navigator.of(context).pop();
              await _approveQrPayload(value);
            },
          ),
        ),
      ),
    );
  }

  Future<void> _approveQrPayload(String rawValue) async {
    try {
      final payload = jsonDecode(rawValue) as Map<String, dynamic>;
      if (payload['kind'] != 'ai-workbench.desktop-pairing') {
        throw Exception('无效二维码');
      }
      final serverUrl = payload['serverUrl'] as String?;
      final code = payload['code'] as String?;
      if (serverUrl == null ||
          serverUrl.isEmpty ||
          code == null ||
          code.isEmpty) {
        throw Exception('二维码缺少配对信息');
      }
      await _approveDesktopPairing(serverUrl: serverUrl, code: code);
    } catch (error) {
      if (!mounted) return;
      setState(() => _scanResult = '扫码配对失败：$error');
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
    setState(() {
      _approving = true;
      _scanResult = null;
      _error = null;
    });
    try {
      await WorkspaceScope.of(context).api.approveDesktopPairing(
            serverUrl: serverUrl,
            code: code,
          );
      await WorkspaceScope.of(context).loadDevices();
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

/// 扫码页：保留 mobile_scanner 相机取景逻辑。
class _DesktopPairingScanner extends StatefulWidget {
  const _DesktopPairingScanner({required this.onDetected});

  final Future<void> Function(String value) onDetected;

  @override
  State<_DesktopPairingScanner> createState() => _DesktopPairingScannerState();
}

class _DesktopPairingScannerState extends State<_DesktopPairingScanner> {
  late final MobileScannerController _controller;
  bool _handled = false;
  bool _starting = true;
  String? _startError;

  @override
  void initState() {
    super.initState();
    _controller = MobileScannerController(
      autoStart: false,
      formats: const [BarcodeFormat.qrCode],
      detectionSpeed: DetectionSpeed.noDuplicates,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _startCamera();
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _startCamera() async {
    if (!mounted) return;
    setState(() {
      _starting = true;
      _startError = null;
    });
    try {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      await _controller.start();
    } catch (error) {
      if (!mounted) return;
      setState(() => _startError = '相机启动失败：$error。可以先返回使用备用短码配对。');
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('扫描桌面二维码')),
      body: Stack(
        children: [
          MobileScanner(
            controller: _controller,
            errorBuilder: (context, error, child) => _ScannerErrorPanel(
              message: _scannerErrorMessage(error),
              onRetry: _startCamera,
            ),
            placeholderBuilder: (context, child) => const ColoredBox(
              color: Colors.black,
              child: Center(
                child: CircularProgressIndicator(color: Colors.white),
              ),
            ),
            onDetect: (capture) {
              if (_handled) return;
              final value = capture.barcodes.isEmpty
                  ? null
                  : capture.barcodes.first.rawValue;
              if (value == null || value.isEmpty) return;
              _handled = true;
              widget.onDetected(value);
            },
          ),
          if (_starting)
            const ColoredBox(
              color: Colors.black,
              child: Center(
                child: CircularProgressIndicator(color: Colors.white),
              ),
            ),
          if (_startError != null)
            _ScannerErrorPanel(message: _startError!, onRetry: _startCamera),
          // 顶部提示气泡
          Align(
            alignment: Alignment.topCenter,
            child: Container(
              width: double.infinity,
              margin: const EdgeInsets.all(AppSpacing.lg),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.ink.withValues(alpha: 0.86),
                borderRadius: BorderRadius.circular(AppRadius.md),
              ),
              child: const Text(
                '把桌面端二维码放入取景框，识别后会自动返回确认。',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 13,
                  height: 1.45,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _scannerErrorMessage(MobileScannerException error) {
    final details = error.errorDetails?.message;
    if (error.errorCode == MobileScannerErrorCode.permissionDenied) {
      return '没有相机权限。请在系统设置里允许应用使用相机，或返回使用备用短码配对。';
    }
    if (error.errorCode == MobileScannerErrorCode.unsupported) {
      return '当前设备暂不支持扫码组件。请返回使用备用短码配对。';
    }
    if (details != null && details.isNotEmpty) {
      return '相机启动失败：$details。可以先返回使用备用短码配对。';
    }
    return '相机启动失败。可以先返回使用备用短码配对。';
  }
}

/// 扫码错误面板：黑底 + 重试/返回按钮。
class _ScannerErrorPanel extends StatelessWidget {
  const _ScannerErrorPanel({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.black,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.x2l),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: Colors.white, size: 42),
              const SizedBox(height: 14),
              Text(
                message,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 16,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 18),
              Wrap(
                alignment: WrapAlignment.center,
                spacing: 10,
                runSpacing: 10,
                children: [
                  FilledButton(
                    onPressed: onRetry,
                    child: const Text('重试相机'),
                  ),
                  OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('返回使用短码'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
