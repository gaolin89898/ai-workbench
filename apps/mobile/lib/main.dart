import 'package:flutter/material.dart';

import 'pages/login_page.dart';
import 'pages/mobile_shell_page.dart';
import 'services/api_client.dart';
import 'state/workspace_controller.dart';
import 'state/workspace_scope.dart';
import 'widgets/app_theme.dart';

void main() {
  runApp(const AiWorkbenchApp());
}

class AiWorkbenchApp extends StatelessWidget {
  const AiWorkbenchApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AI 工作台',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      home: const BootstrapPage(),
    );
  }
}

/// 启动页：检查本地是否已保存登录 token。
/// 有 token 则恢复会话直接进入工作台；无 token 或 token 失效则进入登录页。
class BootstrapPage extends StatefulWidget {
  const BootstrapPage({super.key});

  @override
  State<BootstrapPage> createState() => _BootstrapPageState();
}

class _BootstrapPageState extends State<BootstrapPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  Future<void> _bootstrap() async {
    final token = await ApiClient.loadStoredToken();
    if (token == null || token.isEmpty) {
      _goLogin();
      return;
    }
    final api = ApiClient(baseUrl: ApiClient.defaultBaseUrl);
    api.token = token;
    final controller = WorkspaceController(api: api);
    try {
      await controller.loadDevices();
    } catch (_) {
      // _run 已捕获错误并写入 controller.error
    }
    if (!mounted) return;
    // token 无效或网络异常时回退到登录页
    if (controller.error != null && controller.devices.isEmpty) {
      await ApiClient.clearStoredToken();
      _goLogin();
      return;
    }
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

  void _goLogin() {
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const LoginPage()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: AppColors.background,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(color: AppColors.primary),
            SizedBox(height: AppSpacing.lg),
            Text(
              '正在启动...',
              style: TextStyle(color: AppColors.muted, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}
