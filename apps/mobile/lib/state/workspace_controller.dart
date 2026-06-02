import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/workbench_models.dart';
import '../services/api_client.dart';
import '../services/realtime_client.dart';

class WorkspaceController extends ChangeNotifier {
  WorkspaceController({required this.api}) : realtime = RealtimeClient(api);

  final ApiClient api;
  final RealtimeClient realtime;
  StreamSubscription<Map<String, dynamic>>? _events;

  bool loading = false;
  String? error;
  DesktopDevice? selectedDevice;
  List<DesktopDevice> devices = [];
  List<AiProvider> providers = [];
  List<ProviderStatus> providerStatuses = [];
  List<WorkspaceProject> projects = [];
  List<AiSessionMeta> sessions = [];
  List<ActivityLog> logs = [];
  bool showArchived = false;
  final Map<String, List<ChatMessage>> messagesBySession = {};
  final Map<String, String> runStatusBySession = {};

  List<AiSessionMeta> get visibleSessions =>
      sessions.where((session) => showArchived ? session.archived : !session.archived).toList();

  List<AiSessionMeta> sessionsForProject(String path) =>
      sessions.where((session) => session.summary == path && (showArchived ? session.archived : !session.archived)).toList();

  Future<void> loadDevices() async {
    await _run(() async {
      devices = await api.devices();
      if (selectedDevice != null) {
        selectedDevice = _findDevice(selectedDevice!.id);
      }
    });
  }

  Future<void> selectDevice(DesktopDevice device) async {
    selectedDevice = device;
    notifyListeners();
    await refreshWorkspace();
    _events ??= realtime.events.listen(_handleRealtime);
    realtime.connect();
  }

  Future<void> refreshWorkspace() async {
    final device = selectedDevice;
    if (device == null) return;
    await _run(() async {
      final nextProviders = await api.providers();
      final nextProviderStatuses = await api.deviceProviders(device.id);
      final nextProjects = await api.projects(device.id);
      final nextSessions = await api.aiSessions(device.id);
      final nextLogs = await api.activityLogs(deviceId: device.id);
      providers = nextProviders;
      providerStatuses = nextProviderStatuses;
      projects = nextProjects;
      sessions = nextSessions;
      logs = nextLogs;
    });
  }

  Future<AiSessionMeta?> createCodexSession(WorkspaceProject project) async {
    final device = selectedDevice;
    if (device == null) return null;
    return _runValue(() async {
      final session = await api.createAiSession(
        device.id,
        providerId: 'codex',
        title: '新的 AI CLI 会话',
        projectId: project.id,
        projectPath: project.path,
      );
      _upsertSession(session);
      messagesBySession[session.id] = [
        const ChatMessage(role: ChatRole.system, text: '已创建 Codex 会话。现在可以发送 prompt。'),
      ];
      return session;
    });
  }

  void openSession(AiSessionMeta session) {
    messagesBySession.putIfAbsent(
      session.id,
      () => const [ChatMessage(role: ChatRole.system, text: '正在从桌面端拉取本地历史...')],
    );
    final device = selectedDevice;
    if (device != null) realtime.requestHistory(device.id, session.id);
    notifyListeners();
  }

  void sendPrompt(AiSessionMeta session, String prompt) {
    final device = selectedDevice;
    final trimmed = prompt.trim();
    if (device == null || trimmed.isEmpty) return;
    if (session.providerId != 'codex') {
      _appendMessage(session.id, const ChatMessage(
        role: ChatRole.error,
        text: '移动端结构化聊天暂仅支持 Codex。Claude / Gemini / DeepSeek 请先在桌面端或终端入口使用。',
      ));
      return;
    }
    if (session.archived) {
      _appendMessage(session.id, const ChatMessage(role: ChatRole.error, text: '这个会话已归档。请先恢复后再发送。'));
      return;
    }
    _appendMessage(session.id, ChatMessage(role: ChatRole.user, text: trimmed));
    messagesBySession[session.id] = [
      ...(messagesBySession[session.id] ?? const []),
      const ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [ChatSegment(type: 'status', label: '等待 Codex 返回...', icon: 'think')],
      ),
    ];
    runStatusBySession[session.id] = '正在发送给 Codex';
    notifyListeners();
    realtime.sendPrompt(device.id, session.id, trimmed);
  }

  void archiveSession(AiSessionMeta session, bool archived) {
    final device = selectedDevice;
    if (device == null) return;
    realtime.archiveSession(device.id, session.id, archived);
    runStatusBySession[session.id] = archived ? '正在归档...' : '正在恢复...';
    notifyListeners();
  }

  void toggleArchived() {
    showArchived = !showArchived;
    notifyListeners();
  }

  Future<void> _run(Future<void> Function() action) async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      await action();
    } catch (err) {
      error = err.toString();
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<T?> _runValue<T>(Future<T> Function() action) async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      return await action();
    } catch (err) {
      error = err.toString();
      return null;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  void _handleRealtime(Map<String, dynamic> json) {
    final device = selectedDevice;
    if (device != null && json['deviceId'] != null && json['deviceId'] != device.id) return;
    switch (json['type']) {
      case 'desktop.heartbeat':
        if (device != null) selectedDevice = device.copyWith(online: true, lastSeenAt: json['timestamp'] as String?);
        break;
      case 'providers.snapshot':
        providerStatuses = ((json['providers'] as List<dynamic>?) ?? const [])
            .map((item) => ProviderStatus.fromJson(item as Map<String, dynamic>))
            .toList();
        break;
      case 'projects.snapshot':
        projects = ((json['projects'] as List<dynamic>?) ?? const [])
            .map((item) => WorkspaceProject.fromJson(item as Map<String, dynamic>))
            .toList();
        break;
      case 'ai.sessions.snapshot':
        sessions = ((json['sessions'] as List<dynamic>?) ?? const [])
            .map((item) => AiSessionMeta.fromJson(item as Map<String, dynamic>))
            .toList();
        break;
      case 'ai.history.response':
        final sessionId = json['aiSessionId'] as String;
        messagesBySession[sessionId] = ((json['messages'] as List<dynamic>?) ?? const [])
            .map((item) => AiHistoryMessage.fromJson(item as Map<String, dynamic>))
            .map((item) => ChatMessage(role: item.role, text: item.content))
            .toList();
        break;
      case 'ai.chat.output':
        _handleChatOutput(json);
        break;
      case 'ai.message.done':
        final sessionId = json['aiSessionId'] as String;
        runStatusBySession[sessionId] = json['status'] as String? ?? 'idle';
        break;
      case 'terminal.error':
        final sessionId = json['aiSessionId'] as String?;
        if (sessionId != null) {
          _appendMessage(sessionId, ChatMessage(role: ChatRole.error, text: json['message'] as String? ?? '远程错误'));
        }
        break;
    }
    notifyListeners();
  }

  void _handleChatOutput(Map<String, dynamic> json) {
    final sessionId = json['aiSessionId'] as String;
    final kind = json['kind'] as String? ?? 'status';
    final text = json['text'] as String?;
    final segmentJson = json['segment'] as Map<String, dynamic>?;
    final segment = segmentJson == null ? null : ChatSegment.fromJson(segmentJson);
    final current = [...(messagesBySession[sessionId] ?? const <ChatMessage>[])];
    final pendingIndex = current.lastIndexWhere((message) => message.pending && message.role == ChatRole.assistant);
    if (kind == 'done') {
      final done = ChatMessage(
        role: ChatRole.assistant,
        text: text,
        segments: [if (segment != null) segment],
      );
      if (pendingIndex >= 0) {
        current[pendingIndex] = done;
      } else {
        current.add(done);
      }
      runStatusBySession[sessionId] = '已完成';
    } else if (kind == 'error') {
      final errorMessage = ChatMessage(
        role: ChatRole.error,
        text: text ?? segment?.message ?? 'Codex 执行失败',
        segments: [if (segment != null) segment],
      );
      if (pendingIndex >= 0) {
        current[pendingIndex] = errorMessage;
      } else {
        current.add(errorMessage);
      }
      runStatusBySession[sessionId] = '执行失败';
    } else {
      final nextSegment = segment ?? ChatSegment(type: 'status', label: text ?? 'Codex 正在执行', icon: 'think');
      if (pendingIndex >= 0) {
        final pending = current[pendingIndex];
        current[pendingIndex] = pending.copyWith(segments: [...pending.segments, nextSegment]);
      } else {
        current.add(ChatMessage(role: ChatRole.assistant, pending: true, segments: [nextSegment]));
      }
      runStatusBySession[sessionId] = text ?? nextSegment.label ?? 'Codex 正在执行';
    }
    messagesBySession[sessionId] = current;
  }

  void _upsertSession(AiSessionMeta session) {
    sessions = [session, ...sessions.where((item) => item.id != session.id)];
    notifyListeners();
  }

  void _appendMessage(String sessionId, ChatMessage message) {
    messagesBySession[sessionId] = [...(messagesBySession[sessionId] ?? const []), message];
    notifyListeners();
  }

  DesktopDevice? _findDevice(String id) {
    for (final device in devices) {
      if (device.id == id) return device;
    }
    return null;
  }

  @override
  void dispose() {
    _events?.cancel();
    realtime.close();
    super.dispose();
  }
}
