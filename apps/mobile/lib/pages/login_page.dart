import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../state/workspace_controller.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import 'mobile_shell_page.dart';

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _server = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _loading = false;
  bool _showPassword = false;
  bool _rememberPassword = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadSavedCredentials();
  }

  @override
  void dispose() {
    _server.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _loadSavedCredentials() async {
    final server = await ApiClient.loadStoredBaseUrl();
    final email = await ApiClient.loadSavedEmail();
    final password = await ApiClient.loadSavedPassword();
    if (!mounted) return;
    setState(() {
      if (server != null) {
        _server.text = server;
      }
    });
    if (email != null && password != null) {
      setState(() {
        _email.text = email;
        _password.text = password;
        _rememberPassword = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AppColors.background,
      body: Stack(
        children: [
          // 全屏背景：linear-gradient(180deg, primarySoft 0% → transparent 34%)
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: const [
                    AppColors.primarySoft,
                    Colors.transparent,
                  ],
                  stops: const [0.0, 0.34],
                ),
              ),
            ),
          ),
          SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg,
                AppSpacing.x2l,
                AppSpacing.lg,
                AppSpacing.x3l,
              ),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 430),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // ---- brand-lockup：横向 Row，logo + 标题/副标题 ----
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          ClipRRect(
                            borderRadius: BorderRadius.circular(AppRadius.xl),
                            child: Image.asset(
                              'assets/brand/ai-workbench-app-icon.png',
                              width: 56,
                              height: 56,
                              fit: BoxFit.cover,
                            ),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'AI 工作台',
                                  style: theme.displaySmall
                                      ?.copyWith(fontWeight: FontWeight.w800),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  '桌面端认证同步',
                                  style: theme.bodyMedium,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      // ---- trust-row：状态圆点 + 文案 pill ----
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Container(
                          height: 30,
                          padding: const EdgeInsets.symmetric(horizontal: 10),
                          decoration: BoxDecoration(
                            color: AppColors.surface,
                            borderRadius: BorderRadius.circular(AppRadius.full),
                            border: Border.all(color: AppColors.border),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const AppStatusDot(
                                  size: 7, color: AppColors.success),
                              const SizedBox(width: 6),
                              Text(
                                '桌面端认证同步',
                                style: theme.bodyMedium,
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: AppSpacing.x2l),
                      // ---- auth-card：表单卡 ----
                      AppCard(
                        padding: const EdgeInsets.all(AppSpacing.xl),
                        borderRadius: AppRadius.xl,
                        shadow: AppShadows.card,
                        background: AppColors.surface,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            _IconPrefixTextField(
                              controller: _server,
                              icon: Icons.dns_outlined,
                              hint: '服务器地址',
                              keyboardType: TextInputType.url,
                            ),
                            const SizedBox(height: AppSpacing.md),
                            // 邮箱输入框（前缀图标 + TextField）
                            _IconPrefixTextField(
                              controller: _email,
                              icon: Icons.mail_outline,
                              hint: '邮箱',
                              keyboardType: TextInputType.emailAddress,
                            ),
                            const SizedBox(height: AppSpacing.md),
                            // 密码输入框（前缀图标 + TextField）
                            _IconPrefixTextField(
                              controller: _password,
                              icon: Icons.lock_outline,
                              hint: '密码',
                              obscureText: !_showPassword,
                              suffix: IconButton(
                                tooltip: _showPassword ? '隐藏密码' : '显示密码',
                                icon: Icon(
                                  _showPassword
                                      ? Icons.visibility_off_outlined
                                      : Icons.visibility_outlined,
                                  size: 18,
                                ),
                                color: AppColors.muted,
                                onPressed: () {
                                  setState(
                                      () => _showPassword = !_showPassword);
                                },
                              ),
                            ),
                            const SizedBox(height: AppSpacing.sm),
                            // 忘记密码链接
                            Align(
                              alignment: Alignment.centerRight,
                              child: TextButton(
                                onPressed: () {},
                                style: TextButton.styleFrom(
                                  foregroundColor: AppColors.primary,
                                  padding: EdgeInsets.zero,
                                  minimumSize: const Size(0, 24),
                                  tapTargetSize:
                                      MaterialTapTargetSize.shrinkWrap,
                                ),
                                child: const Text(
                                  '忘记密码',
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: AppColors.primary,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(height: AppSpacing.sm),
                            // 记住密码
                            Row(
                              children: [
                                SizedBox(
                                  width: 20,
                                  height: 20,
                                  child: Checkbox(
                                    value: _rememberPassword,
                                    onChanged: (v) => setState(
                                        () => _rememberPassword = v ?? false),
                                    activeColor: AppColors.primary,
                                    materialTapTargetSize:
                                        MaterialTapTargetSize.shrinkWrap,
                                  ),
                                ),
                                const SizedBox(width: 8),
                                const Text(
                                  '记住密码',
                                  style: TextStyle(
                                    fontSize: 13,
                                    color: AppColors.secondary,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: AppSpacing.md),
                            // 主按钮"继续"：纯色 AppColors.primary + arrow_right 图标
                            _PrimaryButton(
                              loading: _loading,
                              disabled: false,
                              onPressed: _login,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      // ---- status-area：状态提示或错误 ----
                      _StatusArea(
                        error: _error,
                        hint: '使用桌面端账号登录，将自动同步同账号设备。',
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      // ---- device-note：底部说明 ----
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          AppIconBox(
                            icon: Icons.info_outline,
                            size: 34,
                            iconSize: 18,
                            borderRadius: 10,
                            background: AppColors.primarySoftSolid,
                            foreground: AppColors.primary,
                          ),
                          const SizedBox(width: AppSpacing.md),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('移动端登录', style: theme.titleMedium),
                                const SizedBox(height: 2),
                                Text(
                                  '登录后将自动连接桌面设备',
                                  style: theme.bodyMedium,
                                ),
                              ],
                            ),
                          ),
                        ],
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
      final serverUrl = _server.text.trim();
      if (serverUrl.isEmpty) {
        throw Exception('请输入服务器地址');
      }
      await ApiClient.saveStoredBaseUrl(serverUrl);
      final api = ApiClient(baseUrl: serverUrl);
      await api.login(_email.text.trim(), _password.text);
      if (_rememberPassword) {
        await ApiClient.saveCredentials(_email.text.trim(), _password.text);
      } else {
        await ApiClient.clearCredentials();
      }
      final controller = WorkspaceController(api: api);
      await controller.loadDevices();
      if (!mounted) return;
      await _openWorkspace(controller);
    } catch (error) {
      setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openWorkspace(WorkspaceController controller) async {
    final device = controller.preferredInitialDevice();
    if (device != null) {
      await controller.selectDevice(device);
    }
    if (!mounted) return;
    Navigator.of(context).pushReplacement(MaterialPageRoute(
      builder: (_) => WorkspaceScope(
        controller: controller,
        child: const MobileShellPage(),
      ),
    ));
  }
}

/// 带前缀图标的输入框：Container(surfaceMuted + border) + Row[Icon + TextField]
class _IconPrefixTextField extends StatelessWidget {
  const _IconPrefixTextField({
    required this.controller,
    required this.icon,
    required this.hint,
    this.obscureText = false,
    this.keyboardType,
    this.suffix,
  });

  final TextEditingController controller;
  final IconData icon;
  final String hint;
  final bool obscureText;
  final TextInputType? keyboardType;
  final Widget? suffix;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceMuted,
        borderRadius: BorderRadius.circular(AppRadius.lg),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Padding(
            padding: const EdgeInsets.all(14),
            child: Icon(icon, size: 18, color: AppColors.muted),
          ),
          Expanded(
            child: TextField(
              controller: controller,
              obscureText: obscureText,
              keyboardType: keyboardType,
              style: const TextStyle(
                fontSize: 14,
                color: AppColors.ink,
              ),
              decoration: InputDecoration(
                hintText: hint,
                hintStyle: const TextStyle(
                  color: AppColors.muted,
                  fontSize: 14,
                ),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 14),
                filled: false,
              ),
            ),
          ),
          if (suffix != null)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: suffix!,
            ),
        ],
      ),
    );
  }
}

/// 状态提示区：默认 primarySoft 背景 + primary 文案；错误时 danger 风格。
class _StatusArea extends StatelessWidget {
  const _StatusArea({required this.error, required this.hint});

  final String? error;
  final String hint;

  @override
  Widget build(BuildContext context) {
    final hasError = error != null;
    return Container(
      constraints: const BoxConstraints(minHeight: 36),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: hasError ? AppColors.dangerSoft : AppColors.primarySoft,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: hasError
            ? Border.all(color: AppColors.danger)
            : Border.all(color: Colors.transparent),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Icon(
            hasError ? Icons.error_outline : Icons.info_outline,
            size: 18,
            color: hasError ? AppColors.danger : AppColors.primary,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              hasError ? error! : hint,
              style: TextStyle(
                fontSize: 13,
                color: hasError ? AppColors.danger : AppColors.secondary,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 主按钮：高 48 圆角 12，纯色 AppColors.primary 背景 + arrow_right 图标（不使用渐变）
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
        height: 48,
        decoration: BoxDecoration(
          color: AppColors.primary,
          borderRadius: BorderRadius.circular(AppRadius.lg),
        ),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: isDisabled ? null : () => onPressed(),
            borderRadius: BorderRadius.circular(AppRadius.lg),
            child: Center(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    loading ? '连接中...' : '继续',
                    style: const TextStyle(
                      color: AppColors.inverse,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 6),
                  const Icon(Icons.arrow_forward,
                      size: 18, color: AppColors.inverse),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
