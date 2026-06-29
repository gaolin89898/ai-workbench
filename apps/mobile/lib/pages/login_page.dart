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
    final theme = Theme.of(context);
    return Scaffold(
      backgroundColor: AppColors.background,
      body: Stack(
        children: [
          // 顶部光晕：圆心位于屏幕顶部居中，模拟设计稿 radial-gradient
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: Alignment.topCenter,
                  radius: 0.75,
                  colors: const [
                    Color(0x1f2563eb), // rgba(37,99,235,0.12)
                    Color(0x0a2563eb), // rgba(37,99,235,0.04)
                    Colors.transparent,
                  ],
                  stops: const [0.0, 0.42, 0.72],
                ),
              ),
            ),
          ),
          SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.only(
                top: 54,
                left: 22,
                right: 22,
                bottom: AppSpacing.x3l,
              ),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Logo 容器：66×66，圆角 20，heroGradient + 主色阴影
                      Center(
                        child: Container(
                          width: 66,
                          height: 66,
                          decoration: BoxDecoration(
                            gradient: AppColors.heroGradient,
                            borderRadius: BorderRadius.circular(20),
                            boxShadow: AppShadows.primary,
                          ),
                          child: const Icon(
                            Icons.layers,
                            color: AppColors.inverse,
                            size: 32,
                          ),
                        ),
                      ),
                      const SizedBox(height: AppSpacing.xl),
                      // 标题
                      Text(
                        'AI 工作台',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.displaySmall,
                      ),
                      const SizedBox(height: AppSpacing.sm),
                      // 副标题：最大宽 286，居中
                      Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 286),
                          child: Text(
                            '连接桌面端 Codex 工作台，随时随地管理你的 AI 会话',
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontSize: 14,
                              color: AppColors.secondary,
                              height: 1.65,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: AppSpacing.x2l),
                      // 表单卡：圆角 24 + 边框 + elevated 阴影 + 半透明背景
                      AppCard(
                        padding: const EdgeInsets.all(22),
                        borderRadius: AppRadius.x3l,
                        shadow: AppShadows.elevated,
                        background: AppColors.surface.withValues(alpha: 0.92),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            // 邮箱输入框（label 样式由 inputDecorationTheme 提供）
                            TextField(
                              controller: _email,
                              keyboardType: TextInputType.emailAddress,
                              decoration: const InputDecoration(labelText: '邮箱'),
                            ),
                            const SizedBox(height: AppSpacing.md),
                            // 密码输入框
                            TextField(
                              controller: _password,
                              obscureText: true,
                              decoration: const InputDecoration(labelText: '密码'),
                            ),
                            if (_error != null) ...[
                              const SizedBox(height: AppSpacing.md),
                              Text(
                                _error!,
                                style: const TextStyle(
                                  color: AppColors.danger,
                                  fontSize: 13,
                                  height: 1.4,
                                ),
                              ),
                            ],
                            const SizedBox(height: 22),
                            // 主按钮：渐变背景 + 主色阴影
                            _PrimaryButton(
                              loading: _loading,
                              disabled: _oauthLoading,
                              onPressed: _login,
                            ),
                            const SizedBox(height: AppSpacing.md),
                            // 自动注册提示
                            const Center(
                              child: Text(
                                '首次使用将自动创建账号',
                                style: TextStyle(
                                  color: AppColors.muted,
                                  fontSize: 12,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      // 分隔符：Divider + "或" + Divider
                      const Row(
                        children: [
                          Expanded(child: Divider()),
                          Padding(
                            padding: EdgeInsets.symmetric(horizontal: AppSpacing.md),
                            child: Text(
                              '或',
                              style: TextStyle(
                                color: AppColors.muted,
                                fontSize: 12,
                              ),
                            ),
                          ),
                          Expanded(child: Divider()),
                        ],
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      // 钉钉登录按钮：OutlinedButton 变体，左侧带钉钉图标方块
                      OutlinedButton(
                        onPressed: _loading || _oauthLoading
                            ? null
                            : _loginWithDingTalk,
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size.fromHeight(48),
                          backgroundColor: AppColors.surface,
                          side: const BorderSide(color: AppColors.border),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(AppRadius.lg),
                          ),
                          padding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.lg,
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            // 钉钉图标方块：28×28，圆角 10，钉钉蓝底，白色"D"字母
                            Container(
                              width: 28,
                              height: 28,
                              decoration: BoxDecoration(
                                color: AppColors.dingtalk,
                                borderRadius: BorderRadius.circular(AppRadius.md),
                              ),
                              child: const Center(
                                child: Text(
                                  'D',
                                  style: TextStyle(
                                    color: AppColors.inverse,
                                    fontSize: 12,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Text(
                              _oauthLoading ? '等待扫码...' : '钉钉扫码登录',
                              style: const TextStyle(
                                color: AppColors.secondary,
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (_oauthStatus != null) ...[
                        const SizedBox(height: AppSpacing.sm),
                        Text(
                          _oauthStatus!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 12,
                          ),
                        ),
                      ],
                      const SizedBox(height: AppSpacing.x3l),
                      // 底部版本号
                      const Center(
                        child: Text(
                          'v0.1.22',
                          style: TextStyle(
                            color: AppColors.muted,
                            fontSize: 11,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
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

/// 渐变主按钮。背景使用 primaryGradient，叠加主色阴影。
class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({
    required this.loading,
    required this.disabled,
    required this.onPressed,
  });

  final bool loading;
  final bool disabled;
  final Future<void> Function() onPressed;

  @override
  Widget build(BuildContext context) {
    final isDisabled = loading || disabled;
    return Opacity(
      opacity: isDisabled ? 0.6 : 1.0,
      child: Container(
        height: 50,
        decoration: BoxDecoration(
          gradient: AppColors.primaryGradient,
          borderRadius: BorderRadius.circular(AppRadius.xl),
          boxShadow: AppShadows.primary,
        ),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: isDisabled ? null : () => onPressed(),
            borderRadius: BorderRadius.circular(AppRadius.xl),
            child: Center(
              child: Text(
                loading ? '连接中...' : '继续使用',
                style: const TextStyle(
                  color: AppColors.inverse,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
