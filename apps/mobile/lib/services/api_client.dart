import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/workbench_models.dart';

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
      throw Exception(response.body);
    }
  }
}
