import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/api_client.dart';
import '../state/workspace_controller.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'device_list_page.dart';

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _loading = false;
  bool _oauthLoading = false;
  String? _oauthStatus;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: AppCard(
                padding: const EdgeInsets.all(22),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'AI 工作台',
                      style:
                          TextStyle(fontSize: 28, fontWeight: FontWeight.w900),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      '连接桌面端 Codex 工作台',
                      style: TextStyle(color: AppColors.muted),
                    ),
                    const SizedBox(height: 22),
                    TextField(
                      controller: _email,
                      decoration: const InputDecoration(labelText: '邮箱'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _password,
                      obscureText: true,
                      decoration: const InputDecoration(labelText: '密码'),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(_error!,
                          style: const TextStyle(color: AppColors.danger)),
                    ],
                    const SizedBox(height: 18),
                    FilledButton(
                      onPressed: _loading || _oauthLoading ? null : _login,
                      child: Text(_loading ? '连接中...' : '登录并进入工作台'),
                    ),
                    const SizedBox(height: 16),
                    const Row(
                      children: [
                        Expanded(child: Divider()),
                        Padding(
                          padding: EdgeInsets.symmetric(horizontal: 12),
                          child: Text(
                            '或',
                            style: TextStyle(color: AppColors.muted),
                          ),
                        ),
                        Expanded(child: Divider()),
                      ],
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton.icon(
                      onPressed: _loading || _oauthLoading ? null : _loginWithDingTalk,
                      icon: Container(
                        width: 20,
                        height: 20,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: const Color(0xFF1677FF),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: const Text(
                          '钉',
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      label: Text(_oauthLoading ? '等待扫码...' : '钉钉扫码登录'),
                    ),
                    if (_oauthStatus != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        _oauthStatus!,
                        style: const TextStyle(color: AppColors.muted, fontSize: 12),
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _login() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = ApiClient(baseUrl: ApiClient.defaultBaseUrl);
      await api.login(_email.text.trim(), _password.text);
      final controller = WorkspaceController(api: api);
      await controller.loadDevices();
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => WorkspaceScope(
          controller: controller,
          child: const DeviceListPage(),
        ),
      ));
    } catch (error) {
      setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // 钉钉 OAuth 登录：启动 → 浏览器扫码 → 轮询拿 token
  Future<void> _loginWithDingTalk() async {
    setState(() {
      _oauthLoading = true;
      _oauthStatus = '正在获取授权链接...';
      _error = null;
    });
    final api = ApiClient(baseUrl: ApiClient.defaultBaseUrl);
    try {
      final start = await api.startDingTalkOAuth();
      await launchUrl(Uri.parse(start.authUrl),
          mode: LaunchMode.externalApplication);
      setState(() => _oauthStatus = '请在浏览器中扫码完成授权');

      final deadline = DateTime.now().add(const Duration(minutes: 10));
      OAuthPollResult? result;
      while (DateTime.now().isBefore(deadline)) {
        await Future.delayed(const Duration(seconds: 2));
        if (!mounted) return;
        final poll = await api.pollDingTalkOAuth(start.state);
        if (poll.status == 'success' && poll.accessToken != null) {
          result = poll;
          break;
        }
        if (poll.status == 'error') {
          throw Exception(poll.error ?? '钉钉登录失败');
        }
        if (poll.status == 'expired') {
          throw Exception('授权超时，请重试');
        }
      }
      if (result == null) throw Exception('授权超时');

      api.token = result.accessToken;
      await ApiClient.saveStoredToken(result.accessToken!);
      final controller = WorkspaceController(api: api);
      await controller.loadDevices();
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(
        builder: (_) => WorkspaceScope(
          controller: controller,
          child: const DeviceListPage(),
        ),
      ));
    } catch (error) {
      setState(() {
        _error = error.toString().replaceFirst('Exception: ', '');
        _oauthStatus = null;
      });
    } finally {
      if (mounted) setState(() => _oauthLoading = false);
    }
  }
}
