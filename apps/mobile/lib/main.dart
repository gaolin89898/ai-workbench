import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

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
      theme: ThemeData(
        scaffoldBackgroundColor: AppColors.background,
        colorScheme: ColorScheme.fromSeed(
          seedColor: AppColors.primary,
          brightness: Brightness.light,
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: AppColors.background,
          foregroundColor: AppColors.ink,
          elevation: 0,
          centerTitle: false,
          titleTextStyle: TextStyle(
            color: AppColors.ink,
            fontSize: 20,
            fontWeight: FontWeight.w800,
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: AppColors.surfaceMuted,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: AppColors.border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: AppColors.border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: AppColors.primary, width: 1.4),
          ),
        ),
        useMaterial3: true,
      ),
      home: const LoginPage(),
    );
  }
}

class AppColors {
  static const primary = Color(0xff2563eb);
  static const success = Color(0xff22c55e);
  static const warning = Color(0xfff59e0b);
  static const danger = Color(0xffdc2626);
  static const ink = Color(0xff0f172a);
  static const muted = Color(0xff64748b);
  static const border = Color(0xffe2e8f0);
  static const background = Color(0xfff8fafc);
  static const surface = Color(0xffffffff);
  static const surfaceMuted = Color(0xfff1f5f9);
  static const terminal = Color(0xff101827);
}

class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.color = AppColors.surface,
    this.onTap,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final card = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: child,
    );
    if (onTap == null) return card;
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: onTap,
      child: card,
    );
  }
}

class SectionTitle extends StatelessWidget {
  const SectionTitle({
    super.key,
    required this.title,
    required this.subtitle,
    this.action,
  });

  final String title;
  final String subtitle;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  color: AppColors.ink,
                  fontSize: 28,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                subtitle,
                style: const TextStyle(
                  color: AppColors.muted,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
        if (action != null) action!,
      ],
    );
  }
}

class ApiClient {
  ApiClient({required this.baseUrl});

  final String baseUrl;
  String? token;

  Map<String, String> get headers => {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  Uri uri(String path) => Uri.parse('$baseUrl$path');

  Uri wsUri(String path) {
    final httpUri = uri(path);
    return httpUri.replace(
      scheme: httpUri.scheme == 'https' ? 'wss' : 'ws',
      queryParameters: {'token': token ?? ''},
    );
  }

  Future<void> login(String email, String password) async {
    final response = await http.post(
      uri('/auth/login'),
      headers: headers,
      body: jsonEncode({'email': email, 'password': password}),
    );
    if (response.statusCode == 404 || response.statusCode == 401) {
      await register(email, password);
      return;
    }
    _throwIfBad(response);
    token = jsonDecode(response.body)['accessToken'] as String;
  }

  Future<void> register(String email, String password) async {
    final response = await http.post(
      uri('/auth/register'),
      headers: headers,
      body: jsonEncode({'email': email, 'password': password}),
    );
    _throwIfBad(response);
    token = jsonDecode(response.body)['accessToken'] as String;
  }

  Future<List<DesktopDevice>> devices() async {
    final response = await http.get(uri('/devices'), headers: headers);
    _throwIfBad(response);
    final list = jsonDecode(response.body) as List<dynamic>;
    return list.map((value) => DesktopDevice.fromJson(value)).toList();
  }

  Future<List<TerminalSession>> sessions(String deviceId) async {
    final response = await http.get(
      uri('/devices/$deviceId/sessions'),
      headers: headers,
    );
    _throwIfBad(response);
    final list = jsonDecode(response.body) as List<dynamic>;
    return list.map((value) => TerminalSession.fromJson(value)).toList();
  }

  Future<List<AiProvider>> providers() async {
    final response = await http.get(uri('/providers'), headers: headers);
    _throwIfBad(response);
    final list = jsonDecode(response.body) as List<dynamic>;
    return list.map((value) => AiProvider.fromJson(value)).toList();
  }

  Future<List<ProviderStatus>> deviceProviders(String deviceId) async {
    final response = await http.get(uri('/devices/$deviceId/providers'), headers: headers);
    _throwIfBad(response);
    final list = jsonDecode(response.body) as List<dynamic>;
    return list.map((value) => ProviderStatus.fromJson(value)).toList();
  }

  Future<List<WorkspaceProject>> projects(String deviceId) async {
    final response = await http.get(uri('/devices/$deviceId/projects'), headers: headers);
    _throwIfBad(response);
    final list = jsonDecode(response.body) as List<dynamic>;
    return list.map((value) => WorkspaceProject.fromJson(value)).toList();
  }

  Future<WorkspaceProject> createProject(String deviceId, String name, String path) async {
    final response = await http.post(
      uri('/devices/$deviceId/projects'),
      headers: headers,
      body: jsonEncode({'name': name, 'path': path}),
    );
    _throwIfBad(response);
    return WorkspaceProject.fromJson(jsonDecode(response.body));
  }

  Future<List<AiSessionMeta>> aiSessions(String deviceId) async {
    final response = await http.get(uri('/devices/$deviceId/ai-sessions'), headers: headers);
    _throwIfBad(response);
    final list = jsonDecode(response.body) as List<dynamic>;
    return list.map((value) => AiSessionMeta.fromJson(value)).toList();
  }

  Future<AiSessionMeta> createAiSession(
    String deviceId, {
    required String providerId,
    required String title,
    String? projectId,
    String? projectPath,
    String creationMode = 'auto',
    String? terminalSessionId,
  }) async {
    final response = await http.post(
      uri('/devices/$deviceId/ai-sessions'),
      headers: headers,
      body: jsonEncode({
        'providerId': providerId,
        'projectId': projectId,
        'projectPath': projectPath,
        'title': title,
        'creationMode': creationMode,
        'terminalSessionId': terminalSessionId,
      }),
    );
    _throwIfBad(response);
    return AiSessionMeta.fromJson(jsonDecode(response.body));
  }

  Future<DeviceDetail> deviceDetail(String deviceId) async {
    final response = await http.get(uri('/devices/$deviceId'), headers: headers);
    _throwIfBad(response);
    return DeviceDetail.fromJson(jsonDecode(response.body));
  }

  Future<List<ActivityLog>> activityLogs({String? deviceId}) async {
    final path = deviceId == null ? '/activity-logs' : '/activity-logs?device_id=$deviceId';
    final response = await http.get(uri(path), headers: headers);
    _throwIfBad(response);
    final list = jsonDecode(response.body) as List<dynamic>;
    return list.map((value) => ActivityLog.fromJson(value)).toList();
  }

  Future<UserSettings> settings() async {
    final response = await http.get(uri('/settings'), headers: headers);
    _throwIfBad(response);
    return UserSettings.fromJson(jsonDecode(response.body));
  }

  Future<UserSettings> updateSettings(UserSettings settings) async {
    final response = await http.put(
      uri('/settings'),
      headers: headers,
      body: jsonEncode(settings.toJson()),
    );
    _throwIfBad(response);
    return UserSettings.fromJson(jsonDecode(response.body));
  }

  Future<PairingCode> createPairingCode() async {
    final response = await http.post(uri('/pairing/codes'), headers: headers);
    _throwIfBad(response);
    return PairingCode.fromJson(jsonDecode(response.body));
  }

  void _throwIfBad(http.Response response) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception(response.body);
    }
  }
}

class AppSession extends InheritedWidget {
  const AppSession({super.key, required this.client, required super.child});

  final ApiClient client;

  static ApiClient of(BuildContext context) {
    return context.dependOnInheritedWidgetOfExactType<AppSession>()!.client;
  }

  @override
  bool updateShouldNotify(AppSession oldWidget) => client != oldWidget.client;
}

void pushWithSession(BuildContext context, Widget child) {
  final client = AppSession.of(context);
  Navigator.of(context).push(
    MaterialPageRoute(
      builder: (_) => AppSession(client: client, child: child),
    ),
  );
}

String pseudoUuid() {
  final micros = DateTime.now().microsecondsSinceEpoch;
  final suffix = micros.toRadixString(16).padLeft(12, '0');
  return '00000000-0000-4000-8000-${suffix.substring(suffix.length - 12)}';
}

class DesktopDevice {
  DesktopDevice({
    required this.id,
    required this.name,
    required this.os,
    required this.online,
    this.lastSeenAt,
  });

  final String id;
  final String name;
  final String os;
  final bool online;
  final String? lastSeenAt;

  factory DesktopDevice.fromJson(dynamic json) => DesktopDevice(
        id: json['id'] as String,
        name: json['name'] as String,
        os: json['os'] as String,
        online: json['online'] as bool,
        lastSeenAt: json['lastSeenAt'] as String?,
      );
}

class TerminalSession {
  TerminalSession({
    required this.sessionId,
    required this.name,
    required this.backend,
    required this.tool,
    required this.status,
    this.cwd,
  });

  final String sessionId;
  final String name;
  final String backend;
  final String tool;
  final String status;
  final String? cwd;

  factory TerminalSession.fromJson(dynamic json) => TerminalSession(
        sessionId: json['sessionId'] as String,
        name: json['name'] as String,
        backend: json['backend'] as String,
        tool: json['tool'] as String,
        status: json['status'] as String,
        cwd: json['cwd'] as String?,
      );
}

class PairingCode {
  PairingCode({required this.code, required this.expiresAt});

  final String code;
  final String expiresAt;

  factory PairingCode.fromJson(dynamic json) => PairingCode(
        code: json['code'] as String,
        expiresAt: json['expiresAt'] as String,
      );
}

class DeviceDetail {
  DeviceDetail({
    required this.id,
    required this.name,
    required this.os,
    required this.online,
    required this.sessionCount,
    required this.tmuxCount,
    required this.screenCount,
    required this.viewerCount,
    this.lastSeenAt,
    this.latestSessionAt,
  });

  final String id;
  final String name;
  final String os;
  final bool online;
  final int sessionCount;
  final int tmuxCount;
  final int screenCount;
  final int viewerCount;
  final String? lastSeenAt;
  final String? latestSessionAt;

  factory DeviceDetail.fromJson(dynamic json) => DeviceDetail(
        id: json['id'] as String,
        name: json['name'] as String,
        os: json['os'] as String,
        online: json['online'] as bool,
        sessionCount: json['sessionCount'] as int,
        tmuxCount: json['tmuxCount'] as int,
        screenCount: json['screenCount'] as int,
        viewerCount: json['viewerCount'] as int,
        lastSeenAt: json['lastSeenAt'] as String?,
        latestSessionAt: json['latestSessionAt'] as String?,
      );
}

class ActivityLog {
  ActivityLog({
    required this.kind,
    required this.title,
    required this.body,
    required this.risky,
    required this.createdAt,
    this.deviceId,
    this.sessionId,
  });

  final String kind;
  final String title;
  final String body;
  final bool risky;
  final String createdAt;
  final String? deviceId;
  final String? sessionId;

  factory ActivityLog.fromJson(dynamic json) => ActivityLog(
        kind: json['kind'] as String,
        title: json['title'] as String,
        body: json['body'] as String,
        risky: json['risky'] as bool,
        createdAt: json['createdAt'] as String,
        deviceId: json['deviceId'] as String?,
        sessionId: json['sessionId'] as String?,
      );
}

class AiProvider {
  AiProvider({
    required this.id,
    required this.name,
    required this.command,
    required this.builtIn,
    required this.enabled,
  });

  final String id;
  final String name;
  final String command;
  final bool builtIn;
  final bool enabled;

  factory AiProvider.fromJson(dynamic json) => AiProvider(
        id: json['id'] as String,
        name: json['name'] as String,
        command: json['command'] as String,
        builtIn: json['builtIn'] as bool,
        enabled: json['enabled'] as bool,
      );
}

class ProviderStatus {
  ProviderStatus({
    required this.providerId,
    required this.installed,
    required this.authStatus,
    required this.lastCheckedAt,
    this.version,
  });

  final String providerId;
  final bool installed;
  final String authStatus;
  final String lastCheckedAt;
  final String? version;

  factory ProviderStatus.fromJson(dynamic json) => ProviderStatus(
        providerId: json['providerId'] as String,
        installed: json['installed'] as bool,
        authStatus: json['authStatus'] as String,
        lastCheckedAt: json['lastCheckedAt'] as String,
        version: json['version'] as String?,
      );
}

class WorkspaceProject {
  WorkspaceProject({
    required this.id,
    required this.deviceId,
    required this.name,
    required this.path,
    required this.gitDirty,
    required this.updatedAt,
    this.gitBranch,
  });

  final String id;
  final String deviceId;
  final String name;
  final String path;
  final bool gitDirty;
  final String updatedAt;
  final String? gitBranch;

  factory WorkspaceProject.fromJson(dynamic json) => WorkspaceProject(
        id: json['id'] as String,
        deviceId: json['deviceId'] as String,
        name: json['name'] as String,
        path: json['path'] as String,
        gitDirty: json['gitDirty'] as bool,
        updatedAt: json['updatedAt'] as String,
        gitBranch: json['gitBranch'] as String?,
      );
}

class AiSessionMeta {
  AiSessionMeta({
    required this.id,
    required this.deviceId,
    required this.providerId,
    required this.title,
    required this.status,
    required this.updatedAt,
    this.projectId,
    this.terminalSessionId,
    this.summary,
  });

  final String id;
  final String deviceId;
  final String providerId;
  final String title;
  final String status;
  final String updatedAt;
  final String? projectId;
  final String? terminalSessionId;
  final String? summary;

  factory AiSessionMeta.fromJson(dynamic json) => AiSessionMeta(
        id: json['id'] as String,
        deviceId: json['deviceId'] as String,
        providerId: json['providerId'] as String,
        title: json['title'] as String,
        status: json['status'] as String,
        updatedAt: json['updatedAt'] as String,
        projectId: json['projectId'] as String?,
        terminalSessionId: json['terminalSessionId'] as String?,
        summary: json['summary'] as String?,
      );
}

class UserSettings {
  UserSettings({
    required this.commandLoggingEnabled,
    required this.riskConfirmationEnabled,
    required this.outputBufferLines,
    required this.autoReconnectEnabled,
  });

  final bool commandLoggingEnabled;
  final bool riskConfirmationEnabled;
  final int outputBufferLines;
  final bool autoReconnectEnabled;

  factory UserSettings.fromJson(dynamic json) => UserSettings(
        commandLoggingEnabled: json['commandLoggingEnabled'] as bool,
        riskConfirmationEnabled: json['riskConfirmationEnabled'] as bool,
        outputBufferLines: json['outputBufferLines'] as int,
        autoReconnectEnabled: json['autoReconnectEnabled'] as bool,
      );

  Map<String, dynamic> toJson() => {
        'commandLoggingEnabled': commandLoggingEnabled,
        'riskConfirmationEnabled': riskConfirmationEnabled,
        'outputBufferLines': outputBufferLines,
        'autoReconnectEnabled': autoReconnectEnabled,
      };

  UserSettings copyWith({
    bool? commandLoggingEnabled,
    bool? riskConfirmationEnabled,
    int? outputBufferLines,
    bool? autoReconnectEnabled,
  }) {
    return UserSettings(
      commandLoggingEnabled: commandLoggingEnabled ?? this.commandLoggingEnabled,
      riskConfirmationEnabled: riskConfirmationEnabled ?? this.riskConfirmationEnabled,
      outputBufferLines: outputBufferLines ?? this.outputBufferLines,
      autoReconnectEnabled: autoReconnectEnabled ?? this.autoReconnectEnabled,
    );
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _server = TextEditingController(text: 'http://127.0.0.1:8080');
  final _email = TextEditingController(text: 'demo@example.com');
  final _password = TextEditingController(text: 'password123');
  bool _loading = false;
  String? _error;

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
                      style: TextStyle(
                        color: AppColors.ink,
                        fontSize: 32,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      '多 AI Agent 移动工作台',
                      style: TextStyle(
                        color: AppColors.muted,
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 24),
                    TextField(
                      controller: _server,
                      decoration: const InputDecoration(labelText: '服务器地址'),
                    ),
                    const SizedBox(height: 12),
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
                      Text(
                        _error!,
                        style: const TextStyle(color: AppColors.danger),
                      ),
                    ],
                    const SizedBox(height: 20),
                    FilledButton.icon(
                      onPressed: _loading ? null : _login,
                      icon: _loading
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.login),
                      label: const Text('登录 / 自动注册'),
                    ),
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
      final client = ApiClient(baseUrl: _server.text.trim());
      await client.login(_email.text.trim(), _password.text);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => AppSession(
            client: client,
            child: const DeviceListPage(),
          ),
        ),
      );
    } catch (error) {
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }
}

class DeviceListPage extends StatefulWidget {
  const DeviceListPage({super.key});

  @override
  State<DeviceListPage> createState() => _DeviceListPageState();
}

class _DeviceListPageState extends State<DeviceListPage> {
  late Future<List<DesktopDevice>> _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future = AppSession.of(context).devices();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () async {
            setState(() => _future = AppSession.of(context).devices());
            await _future;
          },
          child: FutureBuilder<List<DesktopDevice>>(
            future: _future,
            builder: (context, snapshot) {
              final devices = snapshot.data ?? [];
              return ListView(
                padding: const EdgeInsets.fromLTRB(20, 18, 20, 28),
                children: [
                  SectionTitle(
                    title: 'AI 工作台',
                    subtitle: snapshot.hasData
                        ? '${devices.length} 台桌面 · ${devices.where((d) => d.online).length} 台在线'
                        : '正在加载桌面工作台',
                    action: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          tooltip: '运行日志',
                          icon: const Icon(Icons.receipt_long),
                          onPressed: () => pushWithSession(context, const MobileLogPage()),
                        ),
                        IconButton(
                          tooltip: '设置',
                          icon: const Icon(Icons.settings),
                          onPressed: () => pushWithSession(context, const SettingsPage()),
                        ),
                        IconButton.filled(
                          tooltip: '配对桌面',
                          icon: const Icon(Icons.add),
                          onPressed: () => pushWithSession(context, const PairingPage()),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                  AppCard(
                    color: const Color(0xffeef6ff),
                    child: Row(
                      children: [
                        const Icon(Icons.qr_code_2, color: AppColors.primary),
                        const SizedBox(width: 12),
                        const Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '配对新桌面工作台',
                                style: TextStyle(
                                  color: AppColors.ink,
                                  fontSize: 16,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                              SizedBox(height: 4),
                              Text(
                                '创建配对码，并在 AI 工作台桌面端输入。',
                                style: TextStyle(
                                  color: AppColors.muted,
                                  fontSize: 12,
                                ),
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.chevron_right),
                          onPressed: () => pushWithSession(context, const PairingPage()),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  if (!snapshot.hasData)
                    const Padding(
                      padding: EdgeInsets.only(top: 80),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  else if (devices.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 80),
                      child: Center(child: Text('还没有配对桌面设备。')),
                    )
                  else
                    ...devices.map((device) => Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: AppCard(
                            onTap: () => pushWithSession(
                              context,
                              DeviceDetailPage(device: device),
                            ),
                            child: Row(
                              children: [
                                Container(
                                  width: 44,
                                  height: 44,
                                  decoration: BoxDecoration(
                                    color: AppColors.surfaceMuted,
                                    borderRadius: BorderRadius.circular(9),
                                  ),
                                  child: const Icon(
                                    Icons.monitor,
                                    color: AppColors.primary,
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        device.name,
                                        style: const TextStyle(
                                          color: AppColors.ink,
                                          fontSize: 16,
                                          fontWeight: FontWeight.w800,
                                        ),
                                      ),
                                      const SizedBox(height: 4),
                                      Text(
                                        '${device.os} · ${device.online ? '在线' : '离线'}',
                                        style: TextStyle(
                                          color: device.online
                                              ? AppColors.success
                                              : AppColors.muted,
                                          fontSize: 12,
                                          fontWeight: FontWeight.w700,
                                        ),
                                      ),
                                      const SizedBox(height: 3),
                                      Text(
                                        device.online
                                            ? '心跳正常'
                                            : '最后在线 ${device.lastSeenAt ?? '未知'}',
                                        style: const TextStyle(
                                          color: AppColors.muted,
                                          fontSize: 12,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const Icon(
                                  Icons.chevron_right,
                                  color: AppColors.muted,
                                ),
                              ],
                            ),
                          ),
                        )),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class PairingPage extends StatefulWidget {
  const PairingPage({super.key});

  @override
  State<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends State<PairingPage> {
  Future<PairingCode>? _future;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('设备配对')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: AppCard(
            padding: const EdgeInsets.all(22),
            child: FutureBuilder<PairingCode>(
              future: _future,
              builder: (context, snapshot) {
                if (_future == null) {
                  return Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Icon(
                        Icons.qr_code_2,
                        size: 48,
                        color: AppColors.primary,
                      ),
                      const SizedBox(height: 18),
                      const Text(
                        '创建桌面配对码',
                        style: TextStyle(
                          color: AppColors.ink,
                          fontSize: 24,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        '在桌面端输入这个配对码，就能把电脑绑定到当前账号。',
                        style: TextStyle(
                          color: AppColors.muted,
                          fontSize: 14,
                          height: 1.45,
                        ),
                      ),
                      const SizedBox(height: 24),
                      FilledButton.icon(
                        onPressed: () => setState(() {
                          _future = AppSession.of(context).createPairingCode();
                        }),
                        icon: const Icon(Icons.add_link),
                        label: const Text('创建配对码'),
                      ),
                    ],
                  );
                }
                if (!snapshot.hasData) {
                  return const SizedBox(
                    height: 220,
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                final code = snapshot.data!;
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text(
                      '在桌面端输入配对码',
                      style: TextStyle(
                        color: AppColors.ink,
                        fontSize: 22,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 20),
                    SelectableText(
                      code.code,
                      style: const TextStyle(
                        color: AppColors.ink,
                        fontSize: 42,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 4,
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      '过期时间：${code.expiresAt}',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 13,
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

class DeviceDetailPage extends StatefulWidget {
  const DeviceDetailPage({super.key, required this.device});

  final DesktopDevice device;

  @override
  State<DeviceDetailPage> createState() => _DeviceDetailPageState();
}

class _DeviceDetailPageState extends State<DeviceDetailPage> {
  late Future<DeviceDetail> _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future = AppSession.of(context).deviceDetail(widget.device.id);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.device.name)),
      body: SafeArea(
        child: FutureBuilder<DeviceDetail>(
          future: _future,
          builder: (context, snapshot) {
            final detail = snapshot.data;
            final online = detail?.online ?? widget.device.online;
            final onlineText = online ? '在线' : '离线';
            return RefreshIndicator(
              onRefresh: () async {
                setState(() => _future = AppSession.of(context).deviceDetail(widget.device.id));
                await _future;
              },
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
                children: [
                  SectionTitle(
                    title: '设备详情',
                    subtitle:
                        '${detail?.os ?? widget.device.os} · $onlineText · ${detail?.lastSeenAt ?? widget.device.lastSeenAt ?? '暂无心跳记录'}',
                    action: IconButton(
                      tooltip: '刷新',
                      icon: const Icon(Icons.refresh),
                      onPressed: () => setState(() {
                        _future = AppSession.of(context).deviceDetail(widget.device.id);
                      }),
                    ),
                  ),
                  const SizedBox(height: 18),
                  if (snapshot.hasError)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Text(
                        '设备详情加载失败：${snapshot.error}',
                        style: const TextStyle(color: AppColors.danger),
                      ),
                    ),
                  AppCard(
                    child: Column(
                      children: [
                        _InfoRow(
                          icon: Icons.monitor,
                          label: '设备 ID',
                          value: detail?.id ?? widget.device.id,
                        ),
                        const Divider(height: 24, color: AppColors.border),
                        _InfoRow(
                          icon: Icons.desktop_windows,
                          label: '系统',
                          value: detail?.os ?? widget.device.os,
                        ),
                        const Divider(height: 24, color: AppColors.border),
                        _InfoRow(
                          icon: online ? Icons.wifi : Icons.wifi_off,
                          label: '状态',
                          value: online ? '在线，心跳正常' : '桌面离线，暂不可发送命令',
                          valueColor: online ? AppColors.success : AppColors.muted,
                        ),
                        const Divider(height: 24, color: AppColors.border),
                        _InfoRow(
                          icon: Icons.schedule,
                          label: '最近心跳',
                          value: detail?.lastSeenAt ?? widget.device.lastSeenAt ?? '未知',
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      _MetricBox(
                        value: '${detail?.sessionCount ?? 0}',
                        label: '会话',
                        color: AppColors.primary,
                      ),
                      const SizedBox(width: 10),
                      _MetricBox(
                        value: '${detail?.tmuxCount ?? 0}',
                        label: 'tmux',
                        color: const Color(0xff059669),
                      ),
                      const SizedBox(width: 10),
                      _MetricBox(
                        value: '${detail?.viewerCount ?? 0}',
                        label: '查看者',
                        color: const Color(0xff7c3aed),
                      ),
                    ],
                  ),
                  const SizedBox(height: 18),
                  _ActionCard(
                    icon: Icons.folder_open,
                    title: '选择本地项目',
                    subtitle: '从项目进入，再创建 AI 会话或接管已有会话。',
                    onTap: () => pushWithSession(context, ProjectListPage(device: widget.device)),
                  ),
                  const SizedBox(height: 12),
                  _ActionCard(
                    icon: Icons.smart_toy_outlined,
                    title: 'AI 会话',
                    subtitle: '查看或新建 Codex、Claude Code、Gemini 会话。',
                    onTap: () => pushWithSession(context, AiSessionListPage(device: widget.device)),
                  ),
                  const SizedBox(height: 12),
                  _ActionCard(
                    icon: Icons.extension,
                    title: 'AI 工具',
                    subtitle: '查看 Codex、Claude Code、Gemini、DeepSeek 的可用状态。',
                    onTap: () => pushWithSession(context, ProviderStatusPage(device: widget.device)),
                  ),
                  const SizedBox(height: 12),
                  _ActionCard(
                    icon: Icons.receipt_long,
                    title: '运行日志',
                    subtitle: '查看连接事件、命令摘要、风险确认和错误记录。',
                    onTap: () => pushWithSession(
                      context,
                      MobileLogPage(deviceId: widget.device.id),
                    ),
                  ),
                  const SizedBox(height: 12),
                  _ActionCard(
                    icon: Icons.terminal,
                    title: '底层终端调试',
                    subtitle: '查看 tmux/screen 原始会话，作为高级调试入口。',
                    onTap: () => pushWithSession(context, SessionListPage(device: widget.device)),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}

class ProjectListPage extends StatelessWidget {
  const ProjectListPage({super.key, required this.device});

  final DesktopDevice device;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('项目')),
      body: SafeArea(
        child: FutureBuilder<List<WorkspaceProject>>(
          future: AppSession.of(context).projects(device.id),
          builder: (context, snapshot) {
            final projects = snapshot.data ?? [];
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
              children: [
                SectionTitle(
                  title: '选择本地项目',
                  subtitle: '${device.name} · 选中项目后创建 AI 会话或接管已有会话',
                  action: IconButton.filled(
                    tooltip: '新建 AI 会话',
                    icon: const Icon(Icons.add),
                    onPressed: () => pushWithSession(
                      context,
                      NewAiSessionPage(device: device, projects: projects),
                    ),
                  ),
                ),
                const SizedBox(height: 18),
                if (!snapshot.hasData && !snapshot.hasError)
                  const Padding(
                    padding: EdgeInsets.only(top: 80),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (snapshot.hasError)
                  Text('项目加载失败：${snapshot.error}', style: const TextStyle(color: AppColors.danger))
                else if (projects.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: 80),
                    child: Center(child: Text('还没有登记项目。请先在桌面端添加本机项目目录。')),
                  )
                else
                  ...projects.map(
                    (project) => Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: AppCard(
                        onTap: () => pushWithSession(
                          context,
                          ProjectDetailPage(device: device, project: project),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                const Icon(Icons.folder_open, color: AppColors.primary),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(project.name, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                                      const SizedBox(height: 4),
                                      Text(project.path, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                                    ],
                                  ),
                                ),
                                Text(
                                  project.gitDirty ? '有变更' : '干净',
                                  style: TextStyle(
                                    color: project.gitDirty ? AppColors.warning : AppColors.success,
                                    fontSize: 12,
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 14),
                            Row(
                              children: [
                                Expanded(
                                  child: FilledButton.icon(
                                    onPressed: () => pushWithSession(
                                      context,
                                      NewAiSessionPage(device: device, projects: [project]),
                                    ),
                                    icon: const Icon(Icons.add_comment),
                                    label: const Text('创建会话'),
                                  ),
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: OutlinedButton.icon(
                                    onPressed: () => pushWithSession(
                                      context,
                                      NewAiSessionPage(
                                        device: device,
                                        projects: [project],
                                        initialMode: 'attach',
                                      ),
                                    ),
                                    icon: const Icon(Icons.link),
                                    label: const Text('接管会话'),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class ProjectDetailPage extends StatelessWidget {
  const ProjectDetailPage({super.key, required this.device, required this.project});

  final DesktopDevice device;
  final WorkspaceProject project;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(project.name)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
          children: [
            SectionTitle(
              title: project.name,
              subtitle: '本地项目 · ${project.path}',
              action: IconButton.filled(
                tooltip: '新建会话',
                icon: const Icon(Icons.add_comment),
                onPressed: () => pushWithSession(
                  context,
                  NewAiSessionPage(device: device, projects: [project]),
                ),
              ),
            ),
            const SizedBox(height: 18),
            AppCard(
              child: Column(
                children: [
                  _InfoRow(icon: Icons.account_tree, label: 'Git 分支', value: project.gitBranch ?? '未知'),
                  const Divider(height: 24, color: AppColors.border),
                  _InfoRow(
                    icon: Icons.change_circle,
                    label: '变更状态',
                    value: project.gitDirty ? '有变更文件' : '工作区干净',
                    valueColor: project.gitDirty ? AppColors.warning : AppColors.success,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            _ActionCard(
              icon: Icons.add_comment,
              title: '创建新的 AI 会话',
              subtitle: '为这个项目启动 Codex、Claude Code、Gemini 或 DeepSeek。',
              onTap: () => pushWithSession(context, NewAiSessionPage(device: device, projects: [project])),
            ),
            const SizedBox(height: 12),
            _ActionCard(
              icon: Icons.link,
              title: '接管已有会话',
              subtitle: '把已有 tmux/screen 会话绑定为这个项目的 AI 会话。',
              onTap: () => pushWithSession(
                context,
                NewAiSessionPage(device: device, projects: [project], initialMode: 'attach'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class ProviderStatusPage extends StatelessWidget {
  const ProviderStatusPage({super.key, required this.device});

  final DesktopDevice device;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('AI 工具')),
      body: SafeArea(
        child: FutureBuilder<List<ProviderStatus>>(
          future: AppSession.of(context).deviceProviders(device.id),
          builder: (context, snapshot) {
            final providers = snapshot.data ?? [];
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
              children: [
                SectionTitle(title: 'AI 工具', subtitle: '${device.name} · Provider 可用状态'),
                const SizedBox(height: 18),
                if (!snapshot.hasData && !snapshot.hasError)
                  const Padding(
                    padding: EdgeInsets.only(top: 80),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (snapshot.hasError)
                  Text('工具状态加载失败：${snapshot.error}', style: const TextStyle(color: AppColors.danger))
                else if (providers.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: 80),
                    child: Center(child: Text('桌面端还没有上报 AI 工具状态。')),
                  )
                else
                  ...providers.map(
                    (provider) => Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: AppCard(
                        child: Row(
                          children: [
                            Icon(provider.installed ? Icons.check_circle : Icons.warning_amber, color: provider.installed ? AppColors.success : AppColors.warning),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(provider.providerId, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                                  const SizedBox(height: 4),
                                  Text(provider.version ?? provider.authStatus, style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                                ],
                              ),
                            ),
                            Text(provider.installed ? '可用' : '未安装', style: TextStyle(color: provider.installed ? AppColors.success : AppColors.warning, fontWeight: FontWeight.w800)),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class AiSessionListPage extends StatelessWidget {
  const AiSessionListPage({super.key, required this.device});

  final DesktopDevice device;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('AI 会话')),
      body: SafeArea(
        child: FutureBuilder<List<AiSessionMeta>>(
          future: AppSession.of(context).aiSessions(device.id),
          builder: (context, snapshot) {
            final sessions = snapshot.data ?? [];
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
              children: [
                SectionTitle(
                  title: 'AI 会话',
                  subtitle: '${device.name} · Codex / Claude Code / Gemini / DeepSeek',
                  action: IconButton.filled(
                    tooltip: '新建 AI 会话',
                    icon: const Icon(Icons.add),
                    onPressed: () => pushWithSession(context, NewAiSessionPage(device: device)),
                  ),
                ),
                const SizedBox(height: 18),
                if (!snapshot.hasData && !snapshot.hasError)
                  const Padding(
                    padding: EdgeInsets.only(top: 80),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (snapshot.hasError)
                  Text('AI 会话加载失败：${snapshot.error}', style: const TextStyle(color: AppColors.danger))
                else if (sessions.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: 80),
                    child: Center(child: Text('还没有 AI 会话。')),
                  )
                else
                  ...sessions.map(
                    (session) => Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: AppCard(
                        onTap: () => pushWithSession(context, AiChatPage(device: device, session: session)),
                        child: Row(
                          children: [
                            const Icon(Icons.smart_toy_outlined, color: AppColors.primary),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(session.title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                                  const SizedBox(height: 4),
                                  Text('${session.providerId} · ${session.summary ?? session.terminalSessionId ?? '本地历史在桌面端'}', overflow: TextOverflow.ellipsis, style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                                ],
                              ),
                            ),
                            const Icon(Icons.chevron_right, color: AppColors.muted),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class NewAiSessionPage extends StatefulWidget {
  const NewAiSessionPage({
    super.key,
    required this.device,
    this.projects = const [],
    this.initialMode = 'auto',
  });

  final DesktopDevice device;
  final List<WorkspaceProject> projects;
  final String initialMode;

  @override
  State<NewAiSessionPage> createState() => _NewAiSessionPageState();
}

class _NewAiSessionPageState extends State<NewAiSessionPage> {
  late Future<List<AiProvider>> _providers;
  late Future<List<TerminalSession>> _terminalSessions;
  final _title = TextEditingController(text: '检查项目');
  final _path = TextEditingController();
  String _providerId = 'codex';
  String _mode = 'auto';
  String? _terminalSessionId;
  bool _creating = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _path.text = widget.projects.isNotEmpty ? widget.projects.first.path : '';
    _mode = widget.initialMode;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _providers = AppSession.of(context).providers();
    _terminalSessions = AppSession.of(context).sessions(widget.device.id);
  }

  @override
  void dispose() {
    _title.dispose();
    _path.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('新建 AI 会话')),
      body: SafeArea(
        child: FutureBuilder<List<AiProvider>>(
          future: _providers,
          builder: (context, snapshot) {
            final providers = snapshot.data ?? [];
            if (providers.isNotEmpty && !providers.any((p) => p.id == _providerId)) {
              _providerId = providers.first.id;
            }
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
              children: [
                SectionTitle(
                  title: _mode == 'attach' ? '接管已有会话' : '创建 AI 会话',
                  subtitle: '先确认本地项目，再选择 AI 工具和会话来源。',
                ),
                const SizedBox(height: 18),
                TextField(controller: _title, decoration: const InputDecoration(labelText: '会话标题')),
                const SizedBox(height: 12),
                TextField(controller: _path, decoration: const InputDecoration(labelText: '项目路径')),
                const SizedBox(height: 12),
                if (!snapshot.hasData && !snapshot.hasError)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (snapshot.hasError)
                  Text('AI 工具加载失败：${snapshot.error}', style: const TextStyle(color: AppColors.danger))
                else if (providers.isEmpty)
                  const AppCard(child: Text('云端还没有可用的 AI 工具定义。'))
                else
                  DropdownButtonFormField<String>(
                    value: _providerId,
                    items: providers.map((p) => DropdownMenuItem(value: p.id, child: Text(p.name))).toList(),
                    onChanged: (value) => setState(() => _providerId = value ?? _providerId),
                    decoration: const InputDecoration(labelText: 'AI 工具'),
                  ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: _mode,
                  items: const [
                    DropdownMenuItem(value: 'auto', child: Text('创建新 AI 会话')),
                    DropdownMenuItem(value: 'attach', child: Text('接管已有会话')),
                  ],
                  onChanged: (value) => setState(() => _mode = value ?? 'auto'),
                  decoration: const InputDecoration(labelText: '会话来源'),
                ),
                if (_mode == 'attach') ...[
                  const SizedBox(height: 12),
                  FutureBuilder<List<TerminalSession>>(
                    future: _terminalSessions,
                    builder: (context, sessionSnapshot) {
                      final sessions = sessionSnapshot.data ?? [];
                      if (!sessionSnapshot.hasData && !sessionSnapshot.hasError) {
                        return const AppCard(
                          child: Center(child: CircularProgressIndicator()),
                        );
                      }
                      if (sessionSnapshot.hasError) {
                        return AppCard(
                          child: Text(
                            '会话列表加载失败：${sessionSnapshot.error}',
                            style: const TextStyle(color: AppColors.danger),
                          ),
                        );
                      }
                      if (sessions.isEmpty) {
                        return const AppCard(
                          child: Text(
                            '没有发现可接管的 tmux/screen 会话。请先在桌面端启动 AI CLI 会话。',
                            style: TextStyle(color: AppColors.muted, height: 1.45),
                          ),
                        );
                      }
                      if (_terminalSessionId == null || !sessions.any((s) => s.sessionId == _terminalSessionId)) {
                        _terminalSessionId = sessions.first.sessionId;
                      }
                      return DropdownButtonFormField<String>(
                        value: _terminalSessionId,
                        items: sessions
                            .map(
                              (session) => DropdownMenuItem(
                                value: session.sessionId,
                                child: Text('${session.name} · ${session.sessionId} · ${session.cwd ?? session.backend}'),
                              ),
                            )
                            .toList(),
                        onChanged: (value) => setState(() => _terminalSessionId = value),
                        decoration: const InputDecoration(labelText: '选择已有会话'),
                      );
                    },
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: const TextStyle(color: AppColors.danger)),
                ],
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: _creating || providers.isEmpty ? null : _create,
                  icon: _creating ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.add_comment),
                  label: const Text('创建会话'),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Future<void> _create() async {
    setState(() {
      _creating = true;
      _error = null;
    });
    try {
      final client = AppSession.of(context);
      final session = await AppSession.of(context).createAiSession(
        widget.device.id,
        providerId: _providerId,
        title: _title.text.trim(),
        projectId: widget.projects.isNotEmpty ? widget.projects.first.id : null,
        projectPath: _path.text.trim(),
        creationMode: _mode,
        terminalSessionId: _mode == 'attach' ? _terminalSessionId : null,
      );
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => AppSession(
            client: client,
            child: AiChatPage(device: widget.device, session: session),
          ),
        ),
      );
    } catch (error) {
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }
}

class AiChatPage extends StatefulWidget {
  const AiChatPage({super.key, required this.device, required this.session});

  final DesktopDevice device;
  final AiSessionMeta session;

  @override
  State<AiChatPage> createState() => _AiChatPageState();
}

class _AiChatPageState extends State<AiChatPage> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<_ChatMessage> _messages = [];
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  String _status = 'connecting';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _connect();
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _channel?.sink.close();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          SafeArea(
            bottom: false,
            child: ListTile(
              leading: IconButton(icon: const Icon(Icons.chevron_left), onPressed: () => Navigator.pop(context)),
              title: Text(widget.session.title, style: const TextStyle(fontWeight: FontWeight.w800)),
              subtitle: Text('${widget.session.providerId} · $_status'),
              trailing: IconButton(icon: const Icon(Icons.stop_circle_outlined), onPressed: _stop),
            ),
          ),
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.all(14),
              itemCount: _messages.isEmpty ? 1 : _messages.length,
              itemBuilder: (_, index) => _messages.isEmpty
                  ? _ChatBubble(message: _ChatMessage(role: ChatRole.assistant, text: '桌面在线时会从本机 SQLite 拉取历史。现在可以继续发送 prompt。'))
                  : _ChatBubble(message: _messages[index]),
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 4,
                      decoration: const InputDecoration(hintText: '发送给 AI 会话'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  SizedBox(width: 44, height: 44, child: FilledButton(onPressed: _send, child: const Icon(Icons.send))),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _connect() {
    if (_channel != null) return;
    final client = AppSession.of(context);
    final channel = WebSocketChannel.connect(client.wsUri('/ws/mobile'));
    _channel = channel;
    _subscription = channel.stream.listen(_handleMessage, onDone: () => setState(() => _status = 'disconnected'), onError: (_) => setState(() => _status = 'error'));
    setState(() => _status = 'online');
    channel.sink.add(jsonEncode({
      'type': 'ai.history.request',
      'deviceId': widget.device.id,
      'aiSessionId': widget.session.id,
      'requestId': pseudoUuid(),
    }));
  }

  void _handleMessage(dynamic raw) {
    final json = jsonDecode(raw as String) as Map<String, dynamic>;
    if (json['deviceId'] != widget.device.id) return;
    if (json['type'] == 'ai.message.delta' && json['aiSessionId'] == widget.session.id) {
      setState(() => _appendAssistant(json['content'] as String));
      _scrollToBottom();
    }
    if (json['type'] == 'ai.history.response' && json['aiSessionId'] == widget.session.id) {
      final messages = (json['messages'] as List<dynamic>? ?? []).map((item) {
        final map = item as Map<String, dynamic>;
        return _ChatMessage(role: _roleFromString(map['role'] as String), text: map['content'] as String);
      }).toList();
      setState(() => _messages
        ..clear()
        ..addAll(messages));
      _scrollToBottom();
    }
    if (json['type'] == 'terminal.error') {
      setState(() => _messages.add(_ChatMessage(role: ChatRole.error, text: json['message'] as String)));
    }
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    var confirmedRisk = false;
    if (isRiskyCommand(text)) {
      confirmedRisk = await _confirmRisk() ?? false;
      if (!confirmedRisk) return;
    }
    _channel?.sink.add(jsonEncode({
      'type': 'ai.message.send',
      'deviceId': widget.device.id,
      'aiSessionId': widget.session.id,
      'content': text,
      'confirmedRisk': confirmedRisk,
    }));
    setState(() => _messages.add(_ChatMessage(role: ChatRole.user, text: text)));
    _input.clear();
    _scrollToBottom();
  }

  void _stop() {
    setState(() => _messages.add(const _ChatMessage(role: ChatRole.system, text: '已请求停止当前 AI 任务。')));
  }

  void _appendAssistant(String chunk) {
    if (_messages.isNotEmpty && _messages.last.role == ChatRole.assistant) {
      final last = _messages.removeLast();
      _messages.add(last.copyWith(text: '${last.text}$chunk'));
    } else {
      _messages.add(_ChatMessage(role: ChatRole.assistant, text: chunk));
    }
  }

  void _scrollToBottom() {
    Timer(const Duration(milliseconds: 50), () {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  ChatRole _roleFromString(String value) {
    return switch (value) {
      'user' => ChatRole.user,
      'assistant' => ChatRole.assistant,
      'error' => ChatRole.error,
      _ => ChatRole.system,
    };
  }

  Future<bool?> _confirmRisk() {
    return showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('确认高危内容'),
        content: const Text('这条消息可能触发危险命令，确认后才会发送到桌面端。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('确认发送')),
        ],
      ),
    );
  }
}

class MobileLogPage extends StatelessWidget {
  const MobileLogPage({super.key, this.deviceId});

  final String? deviceId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('日志')),
      body: SafeArea(
        child: FutureBuilder<List<ActivityLog>>(
          future: AppSession.of(context).activityLogs(deviceId: deviceId),
          builder: (context, snapshot) {
            final logs = snapshot.data ?? [];
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
              children: [
                SectionTitle(
                  title: '最近日志',
                  subtitle: deviceId == null ? '全部设备的命令、错误、风险和连接事件。' : '当前设备的运行事件。',
                ),
                const SizedBox(height: 18),
                if (!snapshot.hasData && !snapshot.hasError)
                  const Padding(
                    padding: EdgeInsets.only(top: 80),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (snapshot.hasError)
                  Text(
                    '日志加载失败：${snapshot.error}',
                    style: const TextStyle(color: AppColors.danger),
                  )
                else if (logs.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: 80),
                    child: Center(child: Text('还没有运行日志。')),
                  )
                else
                  ...logs.map((item) {
                    final meta = _logMeta(item.kind);
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: AppCard(
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Container(
                              width: 42,
                              height: 42,
                              decoration: BoxDecoration(
                                color: meta.color.withOpacity(0.12),
                                borderRadius: BorderRadius.circular(9),
                              ),
                              child: Icon(meta.icon, color: meta.color),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Text(
                                        meta.label,
                                        style: TextStyle(
                                          color: meta.color,
                                          fontSize: 12,
                                          fontWeight: FontWeight.w900,
                                        ),
                                      ),
                                      const Spacer(),
                                      Text(
                                        item.createdAt,
                                        style: const TextStyle(
                                          color: AppColors.muted,
                                          fontSize: 11,
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 5),
                                  Text(
                                    item.title,
                                    style: const TextStyle(
                                      color: AppColors.ink,
                                      fontSize: 15,
                                      fontWeight: FontWeight.w800,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    item.body,
                                    style: const TextStyle(
                                      color: AppColors.muted,
                                      fontSize: 12,
                                      height: 1.45,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  }),
              ],
            );
          },
        ),
      ),
    );
  }
}

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late Future<UserSettings> _future;
  UserSettings? _settings;
  bool _saving = false;
  String? _message;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future = AppSession.of(context).settings();
  }

  @override
  Widget build(BuildContext context) {
    final client = AppSession.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: SafeArea(
        child: FutureBuilder<UserSettings>(
          future: _future,
          builder: (context, snapshot) {
            if (snapshot.hasData && _settings == null) {
              _settings = snapshot.data;
            }
            final settings = _settings;
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
              children: [
                const SectionTitle(
                  title: '移动端设置',
                  subtitle: '服务器、账号、风险确认和本地输出缓存。',
                ),
                const SizedBox(height: 18),
                AppCard(
                  child: Column(
                    children: [
                      _InfoRow(
                        icon: Icons.cloud_queue,
                        label: '服务器地址',
                        value: client.baseUrl,
                      ),
                      const Divider(height: 24, color: AppColors.border),
                      const _InfoRow(
                        icon: Icons.account_circle,
                        label: '账号',
                        value: '当前登录账号',
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                if (!snapshot.hasData && settings == null && !snapshot.hasError)
                  const Padding(
                    padding: EdgeInsets.only(top: 80),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (snapshot.hasError && settings == null)
                  Text(
                    '设置加载失败：${snapshot.error}',
                    style: const TextStyle(color: AppColors.danger),
                  )
                else if (settings != null) ...[
                  AppCard(
                    padding: EdgeInsets.zero,
                    child: Column(
                      children: [
                        SwitchListTile(
                          value: settings.riskConfirmationEnabled,
                          onChanged: (value) => _updateLocal(
                            settings.copyWith(riskConfirmationEnabled: value),
                          ),
                          title: const Text('风险确认'),
                          subtitle: const Text('高危命令发送前弹出二次确认。'),
                        ),
                        const Divider(height: 1, color: AppColors.border),
                        SwitchListTile(
                          value: settings.autoReconnectEnabled,
                          onChanged: (value) => _updateLocal(
                            settings.copyWith(autoReconnectEnabled: value),
                          ),
                          title: const Text('自动重连'),
                          subtitle: const Text('网络恢复后重新连接 WebSocket。'),
                        ),
                        const Divider(height: 1, color: AppColors.border),
                        SwitchListTile(
                          value: settings.commandLoggingEnabled,
                          onChanged: (value) => _updateLocal(
                            settings.copyWith(commandLoggingEnabled: value),
                          ),
                          title: const Text('命令摘要'),
                          subtitle: const Text('审计日志仅保存前 200 字符摘要。'),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          '输出缓存行数',
                          style: TextStyle(
                            color: AppColors.ink,
                            fontSize: 16,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        Slider(
                          min: 1000,
                          max: 20000,
                          divisions: 19,
                          value: settings.outputBufferLines.toDouble(),
                          label: settings.outputBufferLines.toString(),
                          onChanged: (value) => _updateLocal(
                            settings.copyWith(outputBufferLines: value.round()),
                          ),
                        ),
                        Text(
                          '当前：${settings.outputBufferLines} 行',
                          style: const TextStyle(color: AppColors.muted, fontSize: 12),
                        ),
                      ],
                    ),
                  ),
                  if (_message != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      _message!,
                      style: const TextStyle(color: AppColors.success),
                    ),
                  ],
                  const SizedBox(height: 16),
                  FilledButton.icon(
                    onPressed: _saving ? null : _save,
                    icon: _saving
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.save),
                    label: const Text('保存设置'),
                  ),
                ],
                const SizedBox(height: 16),
                OutlinedButton.icon(
                  onPressed: () => Navigator.of(context).popUntil((route) => route.isFirst),
                  icon: const Icon(Icons.logout),
                  label: const Text('退出到设备列表'),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  void _updateLocal(UserSettings settings) {
    setState(() {
      _settings = settings;
      _message = null;
    });
  }

  Future<void> _save() async {
    final settings = _settings;
    if (settings == null) return;
    setState(() {
      _saving = true;
      _message = null;
    });
    try {
      final saved = await AppSession.of(context).updateSettings(settings);
      if (!mounted) return;
      setState(() {
        _settings = saved;
        _message = '设置已保存';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _message = '保存失败：$error');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }
}

class SessionListPage extends StatefulWidget {
  const SessionListPage({super.key, required this.device});

  final DesktopDevice device;

  @override
  State<SessionListPage> createState() => _SessionListPageState();
}

class _SessionListPageState extends State<SessionListPage> {
  late Future<List<TerminalSession>> _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future = AppSession.of(context).sessions(widget.device.id);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () async {
            setState(() => _future = AppSession.of(context).sessions(widget.device.id));
            await _future;
          },
          child: FutureBuilder<List<TerminalSession>>(
            future: _future,
            builder: (context, snapshot) {
              final sessions = snapshot.data ?? [];
              return ListView(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
                children: [
                  TextButton.icon(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.chevron_left),
                    label: Text(widget.device.name),
                    style: TextButton.styleFrom(
                      alignment: Alignment.centerLeft,
                      padding: EdgeInsets.zero,
                    ),
                  ),
                  const SizedBox(height: 10),
                  SectionTitle(
                    title: '底层终端调试',
                    subtitle: 'tmux / screen · ${widget.device.os} · ${widget.device.online ? '在线' : '离线'}',
                    action: IconButton(
                      tooltip: '刷新',
                      icon: const Icon(Icons.refresh),
                      onPressed: () => setState(() {
                        _future = AppSession.of(context).sessions(widget.device.id);
                      }),
                    ),
                  ),
                  const SizedBox(height: 18),
                  Row(
                    children: [
                      _MetricBox(value: '${sessions.length}', label: '会话', color: AppColors.primary),
                      const SizedBox(width: 10),
                      _MetricBox(
                        value: '${sessions.where((s) => s.backend == 'tmux').length}',
                        label: 'tmux',
                        color: const Color(0xff059669),
                      ),
                      const SizedBox(width: 10),
                      const _MetricBox(value: '1', label: '查看者', color: Color(0xff7c3aed)),
                    ],
                  ),
                  const SizedBox(height: 16),
                  if (!snapshot.hasData)
                    const Padding(
                      padding: EdgeInsets.only(top: 80),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  else if (sessions.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 80),
                      child: Center(child: Text('没有发现 tmux 或 screen 会话。')),
                    )
                  else
                    ...sessions.map((session) => Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: AppCard(
                            onTap: () => pushWithSession(
                              context,
                              TerminalPage(
                                device: widget.device,
                                session: session,
                              ),
                            ),
                            child: Row(
                              children: [
                                Container(
                                  width: 42,
                                  height: 42,
                                  decoration: BoxDecoration(
                                    color: session.status == 'running'
                                        ? const Color(0xffdcfce7)
                                        : const Color(0xfffff7ed),
                                    borderRadius: BorderRadius.circular(9),
                                  ),
                                  child: Icon(
                                    Icons.terminal,
                                    color: session.status == 'running'
                                        ? const Color(0xff16a34a)
                                        : AppColors.warning,
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        session.name,
                                        style: const TextStyle(
                                          color: AppColors.ink,
                                          fontSize: 16,
                                          fontWeight: FontWeight.w800,
                                        ),
                                      ),
                                      const SizedBox(height: 4),
                                      Text(
                                        '${_toolLabel(session.tool)} · ${session.cwd ?? session.backend}',
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                          color: AppColors.muted,
                                          fontSize: 12,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const Icon(
                                  Icons.chevron_right,
                                  color: AppColors.muted,
                                ),
                              ],
                            ),
                          ),
                        )),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _MetricBox extends StatelessWidget {
  const _MetricBox({
    required this.value,
    required this.label,
    required this.color,
  });

  final String value;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: AppCard(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              value,
              style: TextStyle(
                color: color,
                fontSize: 22,
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              label,
              style: const TextStyle(
                color: AppColors.muted,
                fontSize: 11,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ActionCard extends StatelessWidget {
  const _ActionCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppColors.surfaceMuted,
              borderRadius: BorderRadius.circular(9),
            ),
            child: Icon(icon, color: AppColors.primary),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: AppColors.ink,
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  subtitle,
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 12,
                    height: 1.35,
                  ),
                ),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: AppColors.muted),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({
    required this.icon,
    required this.label,
    required this.value,
    this.valueColor = AppColors.ink,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color valueColor;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: AppColors.primary, size: 20),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: const TextStyle(
                  color: AppColors.muted,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                value,
                style: TextStyle(
                  color: valueColor,
                  fontSize: 14,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _LogMeta {
  const _LogMeta({
    required this.label,
    required this.icon,
    required this.color,
  });

  final String label;
  final IconData icon;
  final Color color;
}

_LogMeta _logMeta(String kind) {
  return switch (kind) {
    'connection' => const _LogMeta(
        label: '连接',
        icon: Icons.wifi,
        color: AppColors.primary,
      ),
    'command' => const _LogMeta(
        label: '命令',
        icon: Icons.send,
        color: Color(0xff0d9488),
      ),
    'risk' => const _LogMeta(
        label: '风险',
        icon: Icons.warning_amber,
        color: AppColors.warning,
      ),
    'settings' => const _LogMeta(
        label: '设置',
        icon: Icons.settings,
        color: Color(0xff7c3aed),
      ),
    'error' => const _LogMeta(
        label: '错误',
        icon: Icons.error_outline,
        color: AppColors.danger,
      ),
    _ => const _LogMeta(
        label: '事件',
        icon: Icons.receipt_long,
        color: AppColors.muted,
      ),
  };
}

class TerminalPage extends StatefulWidget {
  const TerminalPage({super.key, required this.device, required this.session});

  final DesktopDevice device;
  final TerminalSession session;

  @override
  State<TerminalPage> createState() => _TerminalPageState();
}

class _TerminalPageState extends State<TerminalPage> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<_ChatMessage> _messages = [];
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  String _status = 'connecting';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _connect();
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _channel?.sink.close();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          SafeArea(
            bottom: false,
            child: Container(
              height: 58,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              decoration: const BoxDecoration(
                color: AppColors.surface,
                border: Border(
                  bottom: BorderSide(color: AppColors.border),
                ),
              ),
              child: Row(
                children: [
                  IconButton(
                    icon: const Icon(Icons.chevron_left),
                    color: AppColors.primary,
                    onPressed: () => Navigator.pop(context),
                  ),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          widget.session.name,
                          style: const TextStyle(
                            color: AppColors.ink,
                            fontSize: 17,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${widget.session.backend} · ${_statusLabel(_status)}',
                          style: TextStyle(
                            color: _status == 'online'
                                ? AppColors.success
                                : AppColors.warning,
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: '清空会话',
                    icon: const Icon(Icons.clear_all),
                    onPressed: () => setState(_messages.clear),
                  ),
                ],
              ),
            ),
          ),
          Expanded(
            child: Container(
              width: double.infinity,
              color: AppColors.background,
              child: ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.fromLTRB(14, 14, 14, 18),
                itemCount: _messages.isEmpty ? 1 : _messages.length,
                itemBuilder: (_, index) => _messages.isEmpty
                    ? _ChatBubble(
                        message: _ChatMessage(
                          role: ChatRole.assistant,
                          text:
                              '已连接到 ${widget.session.name}。你可以像聊天一样发送 prompt，也可以用 Ctrl+C 打断桌面端正在运行的任务。',
                        ),
                      )
                    : _ChatBubble(message: _messages[index]),
                ),
              ),
            ),
          ),
          Container(
            decoration: const BoxDecoration(
              color: AppColors.surface,
              border: Border(top: BorderSide(color: AppColors.border)),
            ),
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    Row(
                      children: [
                        _ControlChip(label: 'Ctrl+C', onTap: () => _sendControl('ctrl_c')),
                        const SizedBox(width: 8),
                        _ControlChip(label: 'Enter', onTap: () => _sendControl('enter')),
                        const SizedBox(width: 8),
                        _ControlChip(label: 'Ctrl+D', onTap: () => _sendControl('ctrl_d')),
                        const SizedBox(width: 8),
                        _ControlChip(label: '↑', onTap: () => _sendControl('arrow_up')),
                        const SizedBox(width: 8),
                        _ControlChip(label: '↓', onTap: () => _sendControl('arrow_down')),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _input,
                            minLines: 1,
                            maxLines: 4,
                            decoration: const InputDecoration(
                              hintText: '发送命令或提示词',
                              contentPadding: EdgeInsets.symmetric(
                                horizontal: 12,
                                vertical: 12,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        SizedBox(
                          width: 44,
                          height: 44,
                          child: FilledButton(
                            onPressed: _sendInput,
                            style: FilledButton.styleFrom(
                              padding: EdgeInsets.zero,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                            child: const Icon(Icons.send),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _statusLabel(String value) {
    return switch (value) {
      'online' => '在线',
      'connecting' => '连接中',
      'disconnected' => '已断开',
      'error' => '连接错误',
      _ => value,
    };
  }

  void _connect() {
    if (_channel != null) return;
    final client = AppSession.of(context);
    final channel = WebSocketChannel.connect(client.wsUri('/ws/mobile'));
    _channel = channel;
    _subscription = channel.stream.listen(
      _handleMessage,
      onDone: () => setState(() => _status = 'disconnected'),
      onError: (_) => setState(() => _status = 'error'),
    );
    setState(() => _status = 'online');
  }

  void _handleMessage(dynamic raw) {
    final json = jsonDecode(raw as String) as Map<String, dynamic>;
    if (json['deviceId'] != widget.device.id) return;
    if (json['type'] == 'terminal.output' &&
        json['sessionId'] == widget.session.sessionId) {
      setState(() {
        _appendAssistantChunk(json['chunk'] as String);
      });
      _scrollToBottom();
    }
    if (json['type'] == 'terminal.error') {
      final message = json['message'] as String;
      setState(() => _messages.add(_ChatMessage(role: ChatRole.error, text: message)));
      _scrollToBottom();
    }
  }

  Future<void> _sendInput() async {
    final text = _input.text;
    if (text.trim().isEmpty) return;
    var confirmedRisk = false;
    if (isRiskyCommand(text)) {
      confirmedRisk = await _confirmRisk() ?? false;
      if (!confirmedRisk) return;
    }
    _channel?.sink.add(jsonEncode({
      'type': 'terminal.input',
      'deviceId': widget.device.id,
      'sessionId': widget.session.sessionId,
      'input': '$text\n',
      'inputKind': 'text',
      'confirmedRisk': confirmedRisk,
    }));
    setState(() {
      _messages.add(_ChatMessage(role: ChatRole.user, text: text.trim()));
      _trimMessages();
    });
    _input.clear();
    _scrollToBottom();
  }

  void _sendControl(String control) {
    _channel?.sink.add(jsonEncode({
      'type': 'terminal.control',
      'deviceId': widget.device.id,
      'sessionId': widget.session.sessionId,
      'control': control,
    }));
    setState(() {
      _messages.add(_ChatMessage(role: ChatRole.system, text: '已发送 ${_controlLabel(control)}'));
      _trimMessages();
    });
    _scrollToBottom();
  }

  void _appendAssistantChunk(String chunk) {
    if (chunk.isEmpty) return;
    if (_messages.isNotEmpty && _messages.last.role == ChatRole.assistant) {
      final previous = _messages.removeLast();
      _messages.add(previous.copyWith(text: '${previous.text}$chunk'));
    } else {
      _messages.add(_ChatMessage(role: ChatRole.assistant, text: chunk));
    }
    _trimMessages();
  }

  void _trimMessages() {
    if (_messages.length > 300) {
      _messages.removeRange(0, _messages.length - 300);
    }
  }

  void _scrollToBottom() {
    Timer(const Duration(milliseconds: 50), () {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  String _controlLabel(String control) {
    return switch (control) {
      'ctrl_c' => 'Ctrl+C',
      'enter' => 'Enter',
      'ctrl_d' => 'Ctrl+D',
      'arrow_up' => '↑',
      'arrow_down' => '↓',
      _ => control,
    };
  }

  Future<bool?> _confirmRisk() {
    return showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('确认高危命令'),
        content: const Text('这条命令可能修改或删除本机重要数据，确认后才会发送到桌面端。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('确认发送'),
          ),
        ],
      ),
    );
  }
}

class _ControlChip extends StatelessWidget {
  const _ControlChip({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: InkWell(
        borderRadius: BorderRadius.circular(7),
        onTap: onTap,
        child: Container(
          height: 34,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: AppColors.surfaceMuted,
            borderRadius: BorderRadius.circular(7),
          ),
          child: Text(
            label,
            style: const TextStyle(
              color: Color(0xff334155),
              fontSize: 12,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
      ),
    );
  }
}

enum ChatRole { user, assistant, system, error }

class _ChatMessage {
  const _ChatMessage({required this.role, required this.text});

  final ChatRole role;
  final String text;

  _ChatMessage copyWith({String? text}) {
    return _ChatMessage(role: role, text: text ?? this.text);
  }
}

class _ChatBubble extends StatelessWidget {
  const _ChatBubble({required this.message});

  final _ChatMessage message;

  @override
  Widget build(BuildContext context) {
    final isUser = message.role == ChatRole.user;
    final isSystem = message.role == ChatRole.system;
    final isError = message.role == ChatRole.error;
    final bubbleColor = isUser
        ? AppColors.primary
        : isError
            ? const Color(0xfffff1f2)
            : isSystem
                ? AppColors.surfaceMuted
                : AppColors.surface;
    final textColor = isUser
        ? Colors.white
        : isError
            ? AppColors.danger
            : AppColors.ink;

    if (isSystem) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
            decoration: BoxDecoration(
              color: bubbleColor,
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(
              message.text,
              style: const TextStyle(
                color: AppColors.muted,
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Flexible(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 310),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                decoration: BoxDecoration(
                  color: bubbleColor,
                  border: isUser
                      ? null
                      : Border.all(
                          color: isError ? const Color(0xffffcdd2) : AppColors.border,
                        ),
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(14),
                    topRight: const Radius.circular(14),
                    bottomLeft: Radius.circular(isUser ? 14 : 4),
                    bottomRight: Radius.circular(isUser ? 4 : 14),
                  ),
                ),
                child: SelectableText(
                  message.text.trimRight().isEmpty ? ' ' : message.text.trimRight(),
                  style: TextStyle(
                    color: textColor,
                    fontSize: 14,
                    height: 1.45,
                    fontFamily: isUser ? null : 'monospace',
                    fontWeight: isUser ? FontWeight.w600 : FontWeight.w500,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

String _toolLabel(String tool) {
  return switch (tool) {
    'codex' => 'Codex CLI',
    'claude' => 'Claude Code',
    'gemini' => 'Gemini',
    'deepseek' => 'DeepSeek TUI',
    _ => tool,
  };
}

bool isRiskyCommand(String input) {
  final value = input.toLowerCase();
  return [
    'rm -rf',
    'sudo rm',
    'mkfs',
    'shutdown',
    'reboot',
    'dd if=',
    'chmod -r 777',
    '.ssh',
    'id_rsa',
    'private key',
    'export token=',
    'export secret=',
    'api_key=',
    'apikey=',
    'access_token=',
  ].any(value.contains);
}
