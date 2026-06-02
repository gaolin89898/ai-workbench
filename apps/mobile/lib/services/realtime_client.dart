import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'api_client.dart';

class RealtimeClient {
  RealtimeClient(this.api);

  final ApiClient api;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  bool _closed = false;

  Stream<Map<String, dynamic>> get events => _events.stream;

  bool get connected => _channel != null;

  void connect() {
    if (_channel != null || api.token == null) return;
    _closed = false;
    final channel = WebSocketChannel.connect(api.wsUri('/ws/mobile'));
    _channel = channel;
    _subscription = channel.stream.listen(
      (raw) => _events.add(jsonDecode(raw as String) as Map<String, dynamic>),
      onDone: _scheduleReconnect,
      onError: (_) => _scheduleReconnect(),
    );
  }

  void send(Map<String, dynamic> payload) {
    connect();
    _channel?.sink.add(jsonEncode(payload));
  }

  void requestHistory(String deviceId, String aiSessionId) {
    send({
      'type': 'ai.history.request',
      'deviceId': deviceId,
      'aiSessionId': aiSessionId,
      'requestId': _pseudoUuid(),
    });
  }

  void sendPrompt(String deviceId, String aiSessionId, String content, {bool confirmedRisk = false}) {
    send({
      'type': 'ai.message.send',
      'deviceId': deviceId,
      'aiSessionId': aiSessionId,
      'content': content,
      'confirmedRisk': confirmedRisk,
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

  void _scheduleReconnect() {
    _subscription?.cancel();
    _subscription = null;
    _channel = null;
    if (_closed) return;
    Timer(const Duration(seconds: 2), connect);
  }

  Future<void> close() async {
    _closed = true;
    await _subscription?.cancel();
    await _channel?.sink.close();
    _channel = null;
    await _events.close();
  }
}

String _pseudoUuid() {
  final micros = DateTime.now().microsecondsSinceEpoch;
  final suffix = micros.toRadixString(16).padLeft(12, '0');
  return '00000000-0000-4000-8000-${suffix.substring(suffix.length - 12)}';
}
