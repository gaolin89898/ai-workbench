import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/workbench_models.dart';

class ApiClient {
  ApiClient({required String baseUrl}) : baseUrl = normalizeBaseUrl(baseUrl);

  static const defaultBaseUrl = 'http://8.162.12.148:3000';
  static const _tokenKey = 'auth_token';

  final String baseUrl;
  String? token;

  static Future<String?> loadStoredToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_tokenKey);
  }

  static Future<void> saveStoredToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
  }

  static Future<void> clearStoredToken() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
  }

  static String normalizeBaseUrl(String input) {
    var value = input.trim().replaceFirst(RegExp(r'/+$'), '');
    if (value.isEmpty) return value;
    if (!value.contains('://')) value = 'http://$value';
    final uri = Uri.parse(value);
    if (!uri.hasPort && (uri.scheme == 'http' || uri.scheme == 'https')) {
      return uri.replace(port: 3000).toString().replaceFirst(RegExp(r'/+$'), '');
    }
    return value;
  }

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
    final loginUri = uri('/auth/login');
    late final http.Response response;
    try {
      response = await http.post(
        loginUri,
        headers: headers,
        body: jsonEncode({'email': email, 'password': password}),
      );
    } catch (error) {
      throw Exception('无法连接服务器：$loginUri\n$error');
    }
    if (response.statusCode == 404) {
      await register(email, password);
      return;
    }
    _throwIfBad(response);
    token = jsonDecode(response.body)['accessToken'] as String;
    await saveStoredToken(token!);
  }

  Future<void> register(String email, String password) async {
    final response = await http.post(
      uri('/auth/register'),
      headers: headers,
      body: jsonEncode({'email': email, 'password': password}),
    );
    _throwIfBad(response);
    token = jsonDecode(response.body)['accessToken'] as String;
    await saveStoredToken(token!);
  }

  Future<List<DesktopDevice>> devices() =>
      _getList('/devices', DesktopDevice.fromJson);
  Future<List<AiProvider>> providers() =>
      _getList('/providers', AiProvider.fromJson);
  Future<List<ProviderStatus>> deviceProviders(String deviceId) =>
      _getList('/devices/$deviceId/providers', ProviderStatus.fromJson);
  Future<List<WorkspaceProject>> projects(String deviceId) =>
      _getList('/devices/$deviceId/projects', WorkspaceProject.fromJson);
  Future<List<AiSessionMeta>> aiSessions(String deviceId) =>
      _getList('/devices/$deviceId/ai-sessions', AiSessionMeta.fromJson);
  Future<List<ActivityLog>> activityLogs({String? deviceId}) => _getList(
      deviceId == null ? '/activity-logs' : '/activity-logs?deviceId=$deviceId',
      ActivityLog.fromJson);

  Future<PairingCode> createPairingCode() async {
    final response = await http.post(uri('/pairing/codes'), headers: headers);
    _throwIfBad(response);
    return PairingCode.fromJson(
        jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<void> approveDesktopPairing({
    required String serverUrl,
    required String code,
  }) async {
    final response = await http.post(
      Uri.parse(
          '${serverUrl.replaceFirst(RegExp(r'/$'), '')}/desktop/pairing-requests/${Uri.encodeComponent(code)}/approve'),
      headers: headers,
    );
    _throwIfBad(response);
  }

  Future<AiSessionMeta> createAiSession(
    String deviceId, {
    required String providerId,
    required String title,
    String? projectId,
    String? projectPath,
  }) async {
    final response = await http.post(
      uri('/devices/$deviceId/ai-sessions'),
      headers: headers,
      body: jsonEncode({
        'providerId': providerId,
        'projectId': projectId,
        'projectPath': projectPath,
        'title': title,
        'creationMode': 'pty',
        'terminalSessionId': null,
      }),
    );
    _throwIfBad(response);
    return AiSessionMeta.fromJson(
        jsonDecode(response.body) as Map<String, dynamic>);
  }

  /// PATCH /ai-sessions/{id} — rename a session. The server also forwards
  /// ai.session.rename to the desktop so its local SQLite title updates.
  Future<AiSessionMeta> renameAiSession(
    String sessionId, {
    required String title,
  }) async {
    final response = await http.patch(
      uri('/ai-sessions/${Uri.encodeComponent(sessionId)}'),
      headers: headers,
      body: jsonEncode({'title': title}),
    );
    _throwIfBad(response);
    return AiSessionMeta.fromJson(
        jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<UserSettings> settings() async {
    final response = await http.get(uri('/settings'), headers: headers);
    _throwIfBad(response);
    return UserSettings.fromJson(
        jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<UserSettings> updateSettings(UserSettings settings) async {
    final response = await http.put(
      uri('/settings'),
      headers: headers,
      body: jsonEncode(settings.toJson()),
    );
    _throwIfBad(response);
    return UserSettings.fromJson(
        jsonDecode(response.body) as Map<String, dynamic>);
  }

  // ---- OAuth 钉钉登录 ----

  /// 启动钉钉 OAuth 流程，返回授权 URL + state。
  Future<OAuthStartResult> startDingTalkOAuth() async {
    final response =
        await http.get(uri('/oauth/dingtalk/start'), headers: headers);
    _throwIfBad(response);
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    return OAuthStartResult(
      authUrl: data['authUrl'] as String,
      state: data['state'] as String,
    );
  }

  /// 轮询钉钉 OAuth 登录结果。
  Future<OAuthPollResult> pollDingTalkOAuth(String state) async {
    final response = await http.get(
      uri('/oauth/dingtalk/poll?state=${Uri.encodeComponent(state)}'),
      headers: headers,
    );
    _throwIfBad(response);
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    final status = data['status'] as String;
    return OAuthPollResult(
      status: status,
      accessToken: data['accessToken'] as String?,
      refreshToken: data['refreshToken'] as String?,
      userId: data['userId'] as String?,
      displayName: data['displayName'] as String?,
      provider: data['provider'] as String?,
      error: data['error'] as String?,
    );
  }

  Future<List<T>> _getList<T>(
    String path,
    T Function(Map<String, dynamic>) fromJson,
  ) async {
    final response = await http.get(uri(path), headers: headers);
    _throwIfBad(response);
    final list = jsonDecode(response.body) as List<dynamic>;
    return list.map((item) => fromJson(item as Map<String, dynamic>)).toList();
  }

  void _throwIfBad(http.Response response) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception(_errorMessage(response));
    }
  }

  String _errorMessage(http.Response response) {
    var message = response.body;
    try {
      final data = jsonDecode(response.body);
      if (data is Map<String, dynamic>) {
        message = (data['error'] ?? data['message'] ?? response.body).toString();
      }
    } catch (_) {
      // Keep the raw body. Some proxies return plain text instead of JSON.
    }
    return _localizedErrorMessage(message);
  }

  String _localizedErrorMessage(String message) {
    if (message.contains('password must be at least 6 characters')) {
      return '密码至少需要 6 位。';
    }
    if (message.contains('email is invalid')) {
      return '邮箱格式不正确。';
    }
    if (message.contains('email already registered')) {
      return '账号已存在，请检查密码是否正确。';
    }
    if (message.contains('user not found')) {
      return '账号不存在。';
    }
    if (message.contains('unauthorized')) {
      return '账号或密码不正确。';
    }
    return message;
  }
}

/// OAuth 启动响应：客户端用 url_launcher 打开 authUrl。
class OAuthStartResult {
  const OAuthStartResult({required this.authUrl, required this.state});

  final String authUrl;
  final String state;
}

/// OAuth 轮询响应：status 可能是 pending/success/error/expired。
class OAuthPollResult {
  const OAuthPollResult({
    required this.status,
    this.accessToken,
    this.refreshToken,
    this.userId,
    this.displayName,
    this.provider,
    this.error,
  });

  final String status;
  final String? accessToken;
  final String? refreshToken;
  final String? userId;
  final String? displayName;
  final String? provider;
  final String? error;
}
