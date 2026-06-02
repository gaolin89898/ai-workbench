import 'package:flutter/material.dart';

import 'pages/login_page.dart';
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
      home: const LoginPage(),
    );
  }
}
