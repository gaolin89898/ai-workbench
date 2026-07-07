import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/workbench_models.dart';

class ApiClient {
  ApiClient({required String baseUrl}) : baseUrl = normalizeBaseUrl(baseUrl);

  static const _serverBaseUrlKey = 'server_base_url';
  static const _tokenKey = 'auth_token';
  static const _tokenServerKey = 'auth_token_server_url';
  static const _emailKey = 'saved_email';
  static const _passwordKey = 'saved_password';
  static const _secureStorage = FlutterSecureStorage();
  static const _networkTimeout = Duration(seconds: 12);

  final String baseUrl;
  String? token;

  static Future<String?> loadStoredBaseUrl() async {
    final prefs = await SharedPreferences.getInstance();
    final value = prefs.getString(_serverBaseUrlKey);
    if (value == null || value.trim().isEmpty) return null;
    return normalizeBaseUrl(value);
  }

  static Future<void> saveStoredBaseUrl(String baseUrl) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_serverBaseUrlKey, normalizeBaseUrl(baseUrl));
  }

  static Future<String?> loadStoredToken({String? baseUrl}) async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_tokenKey);
    if (token == null || token.isEmpty) return token;
    if (baseUrl == null || baseUrl.trim().isEmpty) return token;

    final expectedServer = normalizeBaseUrl(baseUrl);
    final savedServer = prefs.getString(_tokenServerKey);
    if (savedServer != expectedServer) {
      await clearStoredToken();
      return null;
    }
    return token;
  }

  static Future<void> saveStoredToken(String token, {String? baseUrl}) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
    if (baseUrl != null && baseUrl.trim().isNotEmpty) {
      await prefs.setString(_tokenServerKey, normalizeBaseUrl(baseUrl));
    }
  }

  static Future<void> clearStoredToken() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    await prefs.remove(_tokenServerKey);
  }

  static Future<void> saveCredentials(String email, String password) async {
    await _secureStorage.write(key: _emailKey, value: email);
    await _secureStorage.write(key: _passwordKey, value: password);
  }

  static Future<String?> loadSavedEmail() async {
    return _secureStorage.read(key: _emailKey);
  }

  static Future<String?> loadSavedPassword() async {
    return _secureStorage.read(key: _passwordKey);
  }

  static Future<bool> hasSavedCredentials() async {
    final email = await _secureStorage.read(key: _emailKey);
    return email != null && email.isNotEmpty;
  }

  static Future<void> clearCredentials() async {
    await _secureStorage.delete(key: _emailKey);
    await _secureStorage.delete(key: _passwordKey);
  }

  static String normalizeBaseUrl(String input) {
    var value = input.trim().replaceFirst(RegExp(r'/+$'), '');
    if (value.isEmpty) return value;
    if (!value.contains('://')) value = 'http://$value';
    var uri = Uri.parse(value);
    if (defaultTargetPlatform == TargetPlatform.android &&
        (uri.host == '127.0.0.1' || uri.host == 'localhost')) {
      uri = uri.replace(host: '10.0.2.2');
    }
    if (!uri.hasPort && (uri.scheme == 'http' || uri.scheme == 'https')) {
      uri = uri.replace(port: 3000);
    }
    return uri.toString().replaceFirst(RegExp(r'/+$'), '');
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
    final response = await _requestWithTimeout(
      http.post(
        loginUri,
        headers: headers,
        body: jsonEncode({'email': email, 'password': password}),
      ),
      loginUri,
    );
    if (response.statusCode == 404) {
      await register(email, password);
      return;
    }
    _throwIfBad(response);
    token = jsonDecode(response.body)['accessToken'] as String;
    await saveStoredToken(token!, baseUrl: baseUrl);
  }

  Future<void> register(String email, String password) async {
    final registerUri = uri('/auth/register');
    final response = await _requestWithTimeout(
      http.post(
        registerUri,
        headers: headers,
        body: jsonEncode({'email': email, 'password': password}),
      ),
      registerUri,
    );
    _throwIfBad(response);
    token = jsonDecode(response.body)['accessToken'] as String;
    await saveStoredToken(token!, baseUrl: baseUrl);
  }

  Future<http.Response> _requestWithTimeout(
    Future<http.Response> request,
    Uri requestUri,
  ) async {
    try {
      return await request.timeout(_networkTimeout);
    } on TimeoutException {
      throw Exception('连接响应超时');
    } catch (error) {
      throw Exception('无法连接服务：$error');
    }
  }

  Future<http.Response> _get(String path) {
    final requestUri = uri(path);
    return _requestWithTimeout(
        http.get(requestUri, headers: headers), requestUri);
  }

  Future<http.Response> _post(
    String path, {
    Object? body,
    Map<String, String>? requestHeaders,
  }) {
    final requestUri = uri(path);
    return _requestWithTimeout(
      http.post(
        requestUri,
        headers: requestHeaders ?? headers,
        body: body,
      ),
      requestUri,
    );
  }

  Future<http.Response> _patch(String path, {Object? body}) {
    final requestUri = uri(path);
    return _requestWithTimeout(
      http.patch(requestUri, headers: headers, body: body),
      requestUri,
    );
  }

  Future<http.Response> _put(String path, {Object? body}) {
    final requestUri = uri(path);
    return _requestWithTimeout(
      http.put(requestUri, headers: headers, body: body),
      requestUri,
    );
  }

  Future<http.Response> _delete(String path) {
    final requestUri = uri(path);
    return _requestWithTimeout(
      http.delete(requestUri, headers: headers),
      requestUri,
    );
  }

  Future<List<DesktopDevice>> devices() =>
      _getList('/devices', DesktopDevice.fromJson);
  Future<DesktopDevice> renameDevice(
    String deviceId, {
    required String name,
  }) async {
    final response = await _patch(
      '/devices/${Uri.encodeComponent(deviceId)}',
      body: jsonEncode({'name': name}),
    );
    _throwIfBad(response);
    return DesktopDevice.fromJson(
        jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<void> deleteDevice(String deviceId) async {
    final response = await _delete('/devices/${Uri.encodeComponent(deviceId)}');
    _throwIfBad(response);
  }

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

  Future<AiSessionMeta> createAiSession(
    String deviceId, {
    required String providerId,
    required String title,
    String? projectId,
    String? projectPath,
  }) async {
    final response = await _post(
      '/devices/$deviceId/ai-sessions',
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
    final response = await _patch(
      '/ai-sessions/${Uri.encodeComponent(sessionId)}',
      body: jsonEncode({'title': title}),
    );
    _throwIfBad(response);
    return AiSessionMeta.fromJson(
        jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<UserSettings> settings() async {
    final response = await _get('/settings');
    _throwIfBad(response);
    return UserSettings.fromJson(
        jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<UserSettings> updateSettings(UserSettings settings) async {
    final response = await _put(
      '/settings',
      body: jsonEncode(settings.toJson()),
    );
    _throwIfBad(response);
    return UserSettings.fromJson(
        jsonDecode(response.body) as Map<String, dynamic>);
  }

  /// GET /token-usage/summary — 拉取云端按工具聚合的 Token 用量。
  Future<TokenUsageSummary> tokenUsageSummary() async {
    final response = await _get('/token-usage/summary');
    _throwIfBad(response);
    return TokenUsageSummary.fromJson(
        jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<Map<String, dynamic>> appRelease({
    required String platform,
    required String currentVersion,
  }) async {
    final response = await _get(
      '/app/releases?platform=${Uri.encodeQueryComponent(platform)}&currentVersion=${Uri.encodeQueryComponent(currentVersion)}',
    );
    _throwIfBad(response);
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<List<T>> _getList<T>(
    String path,
    T Function(Map<String, dynamic>) fromJson,
  ) async {
    final response = await _get(path);
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
        message =
            (data['error'] ?? data['message'] ?? response.body).toString();
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
