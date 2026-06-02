import 'package:flutter/material.dart';

import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';

class PairingPage extends StatefulWidget {
  const PairingPage({super.key});

  @override
  State<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends State<PairingPage> {
  String? _code;
  String? _expiresAt;
  String? _error;
  bool _loading = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('配对桌面')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const AppCard(
            child: Text(
              '在桌面端打开“设备配对”，输入这里生成的一次性配对码。配对后手机就能远程控制桌面端 Codex 会话。',
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  _code ?? '未生成',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                      fontSize: 34, fontWeight: FontWeight.w900),
                ),
                if (_expiresAt != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    '过期时间：$_expiresAt',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: AppColors.muted),
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!,
                      style: const TextStyle(color: AppColors.danger)),
                ],
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _loading ? null : _create,
                  child: Text(_loading ? '生成中...' : '生成配对码'),
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
}
