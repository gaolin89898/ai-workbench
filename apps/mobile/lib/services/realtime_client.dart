import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/workbench_models.dart';
import 'api_client.dart';

class RealtimeClient {
  RealtimeClient(this.api);

  final ApiClient api;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  final List<String> _pendingSends = [];
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  bool _closed = false;
  bool _ready = false;

  Stream<Map<String, dynamic>> get events => _events.stream;

  bool get connected => _channel != null && _ready;

  /// 未连接（或尚未 ready）时排队的待发送消息，测试用只读视图。
  @visibleForTesting
  List<String> get pendingSends => List.unmodifiable(_pendingSends);

  void connect() {
    if (_channel != null || api.token == null) return;
    _closed = false;
    final channel = WebSocketChannel.connect(api.wsUri('/ws/mobile'));
    _channel = channel;
    _ready = false;
    _subscription = channel.stream.listen(
      (raw) => _events.add(jsonDecode(raw as String) as Map<String, dynamic>),
      onDone: _scheduleReconnect,
      onError: (_) => _scheduleReconnect(),
    );
    channel.ready.then((_) {
      if (_closed || !identical(_channel, channel)) return;
      _ready = true;
      _flushPendingSends();
    }).catchError((_) {
      if (identical(_channel, channel)) _scheduleReconnect();
    });
  }

  void send(Map<String, dynamic> payload) {
    final encoded = jsonEncode(payload);
    connect();
    if (_channel == null || !_ready) {
      _pendingSends.add(encoded);
      if (_pendingSends.length > 100) _pendingSends.removeAt(0);
      return;
    }
    _channel?.sink.add(encoded);
  }

  void requestHistory(String deviceId, String aiSessionId) {
    send({
      'type': 'ai.history.request',
      'deviceId': deviceId,
      'aiSessionId': aiSessionId,
      'requestId': _pseudoUuid(),
    });
  }

  void sendPrompt(
    String deviceId,
    String aiSessionId,
    String content, {
    bool confirmedRisk = false,
    String? model,
    String? reasoningEffort,
    String? mode,
    String? goal,
    List<ChatContextAttachment> contexts = const [],
  }) {
    send({
      'type': 'ai.message.send',
      'deviceId': deviceId,
      'aiSessionId': aiSessionId,
      'content': content,
      'confirmedRisk': confirmedRisk,
      if (model != null && model.isNotEmpty) 'model': model,
      if (reasoningEffort != null && reasoningEffort.isNotEmpty)
        'reasoningEffort': reasoningEffort,
      if (mode != null && mode.isNotEmpty) 'mode': mode,
      if (goal != null && goal.isNotEmpty) 'goal': goal,
      if (contexts.isNotEmpty)
        'contexts': contexts.map((context) => context.toJson()).toList(),
    });
  }

  void stopPrompt(String deviceId, String aiSessionId) {
    send({
      'type': 'ai.message.stop',
      'deviceId': deviceId,
      'aiSessionId': aiSessionId,
    });
  }

  void respondApproval(String deviceId, String aiSessionId, String approvalId, String decision) {
    send({
      'type': 'ai.approval.respond',
      'deviceId': deviceId,
      'aiSessionId': aiSessionId,
      'approvalId': approvalId,
      'decision': decision,
    });
  }

  void updateRunSettings(
    String deviceId,
    String providerId, {
    String? model,
    String? reasoningEffort,
  }) {
    send({
      'type': 'ai.run.settings.update',
      'deviceId': deviceId,
      'providerId': providerId,
      if (model != null) 'model': model,
      if (reasoningEffort != null && reasoningEffort.isNotEmpty)
        'reasoningEffort': reasoningEffort,
    });
  }

  void requestProjectFiles(
    String deviceId,
    WorkspaceProject project,
    String requestId, {
    String? directoryPath,
  }) {
    send({
      'type': 'project.files.request',
      'deviceId': deviceId,
      'projectId': project.id,
      'projectPath': project.path,
      'directoryPath': directoryPath,
      'requestId': requestId,
    });
  }

  void requestProjectFilePreview(
    String deviceId,
    WorkspaceProject project,
    String filePath,
    String requestId,
  ) {
    send({
      'type': 'project.file.preview.request',
      'deviceId': deviceId,
      'projectId': project.id,
      'projectPath': project.path,
      'filePath': filePath,
      'requestId': requestId,
    });
  }

  void archiveSession(String deviceId, String aiSessionId, bool archived) {
    send({
      'type': 'ai.session.archive',
      'deviceId': deviceId,
      'aiSessionId': aiSessionId,
      'archived': archived,
    });
  }

  void requestGitStatus(String deviceId, String projectPath, String requestId) {
    send({
      'type': 'git.status.request',
      'deviceId': deviceId,
      'projectPath': projectPath,
      'requestId': requestId,
    });
  }

  void requestGitCommit(String deviceId, String projectPath, String message, String requestId) {
    send({
      'type': 'git.commit.request',
      'deviceId': deviceId,
      'projectPath': projectPath,
      'message': message,
      'requestId': requestId,
    });
  }

  void requestGitPush(String deviceId, String projectPath, String requestId) {
    send({
      'type': 'git.push.request',
      'deviceId': deviceId,
      'projectPath': projectPath,
      'requestId': requestId,
    });
  }

  void requestGitPull(String deviceId, String projectPath, String requestId) {
    send({
      'type': 'git.pull.request',
      'deviceId': deviceId,
      'projectPath': projectPath,
      'requestId': requestId,
    });
  }

  void _scheduleReconnect() {
    _subscription?.cancel();
    _subscription = null;
    _channel = null;
    _ready = false;
    if (_closed) return;
    Timer(const Duration(seconds: 2), connect);
  }

  void _flushPendingSends() {
    final channel = _channel;
    if (channel == null || !_ready || _pendingSends.isEmpty) return;
    final pending = List<String>.from(_pendingSends);
    _pendingSends.clear();
    for (final payload in pending) {
      channel.sink.add(payload);
    }
  }

  Future<void> close() async {
    _closed = true;
    await _subscription?.cancel();
    await _channel?.sink.close();
    _channel = null;
    _ready = false;
    _pendingSends.clear();
    await _events.close();
  }
}

String _pseudoUuid() {
  final micros = DateTime.now().microsecondsSinceEpoch;
  final suffix = micros.toRadixString(16).padLeft(12, '0');
  return '00000000-0000-4000-8000-${suffix.substring(suffix.length - 12)}';
}
