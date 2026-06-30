import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/workbench_models.dart';
import '../services/api_client.dart';
import '../services/realtime_client.dart';

class WorkspaceController extends ChangeNotifier {
  WorkspaceController({required this.api}) : realtime = RealtimeClient(api) {
    _loadPersistence();
  }

  final ApiClient api;
  final RealtimeClient realtime;
  StreamSubscription<Map<String, dynamic>>? _events;
  static const _devicesReloadInterval = Duration(seconds: 5);
  Future<void>? _loadDevicesInFlight;
  DateTime? _lastDevicesLoadedAt;
  final Map<String, Future<AiSessionMeta?>> _createSessionInFlight = {};

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
  final Map<String, String?> _currentAgentMessageStepIds = {};
  bool _notifyQueued = false;

  // Client-side session state (matching desktop's localStorage pattern)
  final Set<String> _pinnedSessionIds = {};
  final Set<String> _unreadSessionIds = {};
  final Map<String, String> _localTitleOverrides = {};

  bool isSessionPinned(String sessionId) => _pinnedSessionIds.contains(sessionId);
  bool isSessionUnread(String sessionId) => _unreadSessionIds.contains(sessionId);
  String getEffectiveTitle(AiSessionMeta session) =>
      _localTitleOverrides[session.id] ?? session.title;

  List<AiSessionMeta> get visibleSessions {
    final filtered = sessions.where((s) => showArchived ? s.archived : !s.archived).toList();
    // Sort: pinned first, then by updatedAt desc
    filtered.sort((a, b) {
      final aPinned = _pinnedSessionIds.contains(a.id) ? 0 : 1;
      final bPinned = _pinnedSessionIds.contains(b.id) ? 0 : 1;
      if (aPinned != bPinned) return aPinned.compareTo(bPinned);
      return b.updatedAt.compareTo(a.updatedAt);
    });
    return filtered;
  }

  List<AiSessionMeta> sessionsForProject(String path) =>
      sessions.where((session) => session.summary == path && (showArchived ? session.archived : !session.archived)).toList();

  bool isCreatingSession(WorkspaceProject project, {String? providerId}) {
    final device = selectedDevice;
    if (device == null) return false;
    final prefix = '${device.id}\x00${project.id}\x00';
    if (providerId != null) {
      return _createSessionInFlight.containsKey('$prefix$providerId');
    }
    return _createSessionInFlight.keys.any((key) => key.startsWith(prefix));
  }

  void _notifySafely() {
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      if (_notifyQueued) return;
      _notifyQueued = true;
      SchedulerBinding.instance.addPostFrameCallback((_) {
        _notifyQueued = false;
        if (!hasListeners) return;
        notifyListeners();
      });
      return;
    }
    notifyListeners();
  }

  Future<void> loadDevices() async {
    final inFlight = _loadDevicesInFlight;
    if (inFlight != null) return inFlight;

    final lastLoadedAt = _lastDevicesLoadedAt;
    if (lastLoadedAt != null &&
        DateTime.now().difference(lastLoadedAt) < _devicesReloadInterval) {
      return;
    }

    final future = _run(() async {
      devices = await api.devices();
      _lastDevicesLoadedAt = DateTime.now();
      if (selectedDevice != null) {
        selectedDevice = _findDevice(selectedDevice!.id);
      }
    });
    _loadDevicesInFlight = future;
    try {
      await future;
    } finally {
      if (identical(_loadDevicesInFlight, future)) {
        _loadDevicesInFlight = null;
      }
    }
  }

  Future<void> selectDevice(DesktopDevice device) async {
    selectedDevice = device;
    _notifySafely();
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

  Future<AiSessionMeta?> createSession(WorkspaceProject project, {String providerId = 'codex'}) async {
    final device = selectedDevice;
    if (device == null) return null;
    final key = '${device.id}\x00${project.id}\x00$providerId';
    final inFlight = _createSessionInFlight[key];
    if (inFlight != null) return inFlight;

    final future = _createSession(device.id, project, providerId);
    _createSessionInFlight[key] = future;
    _notifySafely();
    try {
      return await future;
    } finally {
      if (identical(_createSessionInFlight[key], future)) {
        _createSessionInFlight.remove(key);
        _notifySafely();
      }
    }
  }

  Future<AiSessionMeta?> _createSession(
    String deviceId,
    WorkspaceProject project,
    String providerId,
  ) {
    return _runValue(() async {
      final session = await api.createAiSession(
        deviceId,
        providerId: providerId,
        title: '新的 AI CLI 会话',
        projectId: project.id,
        projectPath: project.path,
      );
      _upsertSession(session);
      messagesBySession[session.id] = [
        ChatMessage(role: ChatRole.system, text: '已创建 $providerId 会话。现在可以发送 prompt。'),
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
    markSessionRead(session.id);
    _notifySafely();
  }

  void sendPrompt(AiSessionMeta session, String prompt) {
    final device = selectedDevice;
    final trimmed = prompt.trim();
    if (device == null || trimmed.isEmpty) return;
    if (session.archived) {
      _appendMessage(session.id, const ChatMessage(role: ChatRole.error, text: '这个会话已归档。请先恢复后再发送。'));
      return;
    }
    _appendMessage(session.id, ChatMessage(role: ChatRole.user, text: trimmed));
    messagesBySession[session.id] = [
      ...(messagesBySession[session.id] ?? const []),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [ChatSegment(type: 'status', label: '等待 ${session.providerId} 返回...', icon: 'think')],
      ),
    ];
    runStatusBySession[session.id] = '正在发送给 ${session.providerId}';
    _notifySafely();
    realtime.sendPrompt(device.id, session.id, trimmed);
    // Best-effort: rename untitled sessions based on the first prompt.
    _maybeRenameUntitledSession(session, trimmed);
  }

  /// If the session still has the default title, derive a new title from the
  /// first prompt line and persist it via the backend PATCH endpoint. The
  /// server then forwards ai.session.rename to the desktop so its local
  /// SQLite title stays in sync.
  Future<void> _maybeRenameUntitledSession(AiSessionMeta session, String prompt) async {
    const untitledNames = {'新的 AI CLI 会话', '接管已有 AI CLI 会话'};
    if (!untitledNames.contains(session.title)) return;
    final firstLine = prompt
        .split(RegExp(r'\r?\n'))
        .firstWhere((line) => line.trim().isNotEmpty, orElse: () => '新的 AI CLI 会话')
        .trim();
    final title = firstLine.length > 24 ? '${firstLine.substring(0, 24)}...' : firstLine;
    if (title.isEmpty || title == session.title) return;
    try {
      final updated = await api.renameAiSession(session.id, title: title);
      _upsertSession(updated);
    } catch (error) {
      debugPrint('renameAiSession failed: $error');
    }
  }

  void archiveSession(AiSessionMeta session, bool archived) {
    final device = selectedDevice;
    if (device == null) return;
    realtime.archiveSession(device.id, session.id, archived);
    runStatusBySession[session.id] = archived ? '正在归档...' : '正在恢复...';
    _notifySafely();
  }

  void toggleArchived() {
    showArchived = !showArchived;
    _notifySafely();
  }

  void toggleSessionPinned(String sessionId) {
    if (_pinnedSessionIds.contains(sessionId)) {
      _pinnedSessionIds.remove(sessionId);
    } else {
      _pinnedSessionIds.add(sessionId);
    }
    _savePinned();
    _notifySafely();
  }

  void markSessionRead(String sessionId) {
    _unreadSessionIds.remove(sessionId);
    _saveUnread();
    _notifySafely();
  }

  void markSessionUnread(String sessionId) {
    _unreadSessionIds.add(sessionId);
    _saveUnread();
    _notifySafely();
  }

  void renameSession(String sessionId, String newTitle) {
    _localTitleOverrides[sessionId] = newTitle;
    _saveTitleOverrides();
    _notifySafely();
  }

  // --- Persistence ---

  Future<void> _loadPersistence() async {
    final prefs = await SharedPreferences.getInstance();
    _pinnedSessionIds.addAll(prefs.getStringList('pinnedSessions') ?? []);
    _unreadSessionIds.addAll(prefs.getStringList('unreadSessions') ?? []);
    for (final entry in (prefs.getStringList('titleOverrides') ?? const [])) {
      final parts = entry.split('\x00');
      if (parts.length == 2) _localTitleOverrides[parts[0]] = parts[1];
    }
    _notifySafely();
  }

  void _savePinned() {
    SharedPreferences.getInstance().then((prefs) {
      prefs.setStringList('pinnedSessions', _pinnedSessionIds.toList());
    });
  }

  void _saveUnread() {
    SharedPreferences.getInstance().then((prefs) {
      prefs.setStringList('unreadSessions', _unreadSessionIds.toList());
    });
  }

  void _saveTitleOverrides() {
    SharedPreferences.getInstance().then((prefs) {
      final entries = _localTitleOverrides.entries.map((e) => '${e.key}\x00${e.value}').toList();
      prefs.setStringList('titleOverrides', entries);
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    loading = true;
    error = null;
    _notifySafely();
    try {
      await action();
    } catch (err) {
      error = err.toString();
    } finally {
      loading = false;
      _notifySafely();
    }
  }

  Future<T?> _runValue<T>(Future<T> Function() action) async {
    loading = true;
    error = null;
    _notifySafely();
    try {
      return await action();
    } catch (err) {
      error = err.toString();
      return null;
    } finally {
      loading = false;
      _notifySafely();
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
            .map((item) => ChatMessage(role: item.role, text: item.content, segments: item.segments))
            .toList();
        break;
      case 'ai.chat.output':
        _handleChatOutput(json);
        break;
      case 'ai.message.delta':
        _handleMessageDelta(json);
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
    _notifySafely();
  }

  void _handleChatOutput(Map<String, dynamic> json) {
    final sessionId = json['aiSessionId'] as String;
    final kind = json['kind'] as String? ?? 'status';
    final text = json['text'] as String?;
    final segmentJson = json['segment'] as Map<String, dynamic>?;
    final segment = segmentJson == null ? null : ChatSegment.fromJson(segmentJson);
    final segments = ((json['segments'] as List<dynamic>?) ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(ChatSegment.fromJson)
        .toList();
    final current = [...(messagesBySession[sessionId] ?? const <ChatMessage>[])];
    final pendingIndex = current.lastIndexWhere((message) => message.pending && message.role == ChatRole.assistant);
    if (kind == 'done') {
      final pending = pendingIndex >= 0 ? current[pendingIndex] : null;
      final incomingSegments = [
        ...segments,
        if (segment != null) segment,
      ];
      final doneText = (text != null && text.isNotEmpty) ? text : pending?.text;
      final doneSegments = pending == null
          ? incomingSegments
          : _mergeSegments(pending.segments, incomingSegments);
      final done = ChatMessage(
        role: ChatRole.assistant,
        text: doneText,
        segments: doneSegments,
      );
      if (pendingIndex >= 0) {
        current[pendingIndex] = done;
      } else if ((doneText ?? '').isNotEmpty || doneSegments.isNotEmpty) {
        final lastAssistantIndex = current.lastIndexWhere(
          (message) => message.role == ChatRole.assistant,
        );
        if (lastAssistantIndex >= 0 && current[lastAssistantIndex].pending) {
          current[lastAssistantIndex] = done;
        } else {
          current.add(done);
        }
      }
      runStatusBySession[sessionId] = '已完成';
      _currentAgentMessageStepIds.remove(sessionId);
    } else if (kind == 'error') {
      final errorMessage = ChatMessage(
        role: ChatRole.error,
        text: text ?? segment?.message ?? 'AI 执行失败',
        segments: [if (segment != null) segment],
      );
      if (pendingIndex >= 0) {
        current[pendingIndex] = errorMessage;
      } else {
        current.add(errorMessage);
      }
      runStatusBySession[sessionId] = '执行失败';
    } else if (kind == 'delta') {
      final deltaText = (text != null && text.isNotEmpty) ? text : segment?.text;
      final deltaStepId = json['stepId'] as String?;
      final currentStepId = _currentAgentMessageStepIds[sessionId];
      final isStepChange = deltaStepId != null && deltaStepId != currentStepId;
      List<ChatSegment> thoughtSegments = const [];
      if (isStepChange && currentStepId != null) {
        final pending = pendingIndex >= 0 ? current[pendingIndex] : null;
        final prevText = (pending?.text ?? '').trim();
        if (prevText.isNotEmpty) {
          thoughtSegments = [
            ChatSegment(
              type: 'thought',
              stepId: 'thought-$currentStepId',
              title: '中间结论',
              text: prevText,
              collapsed: true,
            ),
          ];
        }
      }
      final incomingSegments = [
        ...thoughtSegments,
        ...segments,
        if (segment != null) segment,
      ];
      if (isStepChange) {
        _currentAgentMessageStepIds[sessionId] = deltaStepId;
      }
      if (pendingIndex >= 0) {
        final pending = current[pendingIndex];
        final accumulated = isStepChange
            ? (deltaText ?? '')
            : (deltaText == null || deltaText.isEmpty
                ? pending.text
                : (pending.text ?? '') + deltaText);
        current[pendingIndex] = pending.copyWith(
          text: accumulated,
          segments: _mergeSegments(pending.segments, incomingSegments),
        );
      } else {
        final lastAssistantIndex = current.lastIndexWhere(
          (message) => message.role == ChatRole.assistant,
        );
        if (lastAssistantIndex >= 0 && current[lastAssistantIndex].pending) {
          final pending = current[lastAssistantIndex];
          final accumulated = isStepChange
              ? (deltaText ?? '')
              : (deltaText == null || deltaText.isEmpty
                  ? pending.text
                  : (pending.text ?? '') + deltaText);
          current[lastAssistantIndex] = pending.copyWith(
            text: accumulated,
            segments: _mergeSegments(pending.segments, incomingSegments),
          );
        } else if ((deltaText ?? '').isNotEmpty || incomingSegments.isNotEmpty) {
          current.add(ChatMessage(
            role: ChatRole.assistant,
            pending: true,
            text: deltaText,
            segments: incomingSegments,
          ));
        }
      }
    } else {
      if (text == 'mobile sent message') return;
      final incomingSegments = [
        ...segments,
        if (segment != null) segment,
        if (segment == null && segments.isEmpty)
          ChatSegment(type: 'status', label: text ?? 'AI 正在执行', icon: 'think'),
      ];
      if (pendingIndex >= 0) {
        final pending = current[pendingIndex];
        current[pendingIndex] = pending.copyWith(
          segments: _mergeSegments(pending.segments, incomingSegments),
        );
      } else {
        final lastAssistantIndex = current.lastIndexWhere(
          (message) => message.role == ChatRole.assistant,
        );
        if (lastAssistantIndex >= 0 && current[lastAssistantIndex].pending) {
          final pending = current[lastAssistantIndex];
          current[lastAssistantIndex] = pending.copyWith(
            segments: _mergeSegments(pending.segments, incomingSegments),
          );
        } else {
          current.add(ChatMessage(
            role: ChatRole.assistant,
            pending: true,
            segments: incomingSegments,
          ));
        }
      }
      runStatusBySession[sessionId] =
          text ?? (incomingSegments.isEmpty ? null : incomingSegments.last.label) ?? 'AI 正在执行';
    }
    messagesBySession[sessionId] = current;
  }

  List<ChatSegment> _mergeSegments(
    List<ChatSegment> source,
    List<ChatSegment> segments,
  ) {
    var next = [...source];
    for (final segment in segments) {
      next = _mergeSegment(next, segment);
    }
    return next;
  }

  List<ChatSegment> _mergeSegment(List<ChatSegment> source, ChatSegment segment) {
    final stepId = segment.stepId;
    if (stepId == null || stepId.isEmpty) return [...source, segment];
    final index = source.indexWhere((item) => item.stepId == stepId);
    if (index < 0) return [...source, segment];
    final next = [...source];
    next[index] = _mergeSegmentFields(next[index], segment);
    return next;
  }

  ChatSegment _mergeSegmentFields(
    ChatSegment previous,
    ChatSegment next,
  ) => ChatSegment(
        type: next.type,
        stepId: next.stepId ?? previous.stepId,
        text: next.text ?? previous.text,
        label: next.label ?? previous.label,
        detail: next.detail ?? previous.detail,
        icon: next.icon ?? previous.icon,
        title: next.title ?? previous.title,
        toolName: next.toolName ?? previous.toolName,
        command: next.command ?? previous.command,
        status: next.status ?? previous.status,
        summary: next.summary ?? previous.summary,
        input: next.input ?? previous.input,
        output: next.output ?? previous.output,
        diff: next.diff ?? previous.diff,
        message: next.message ?? previous.message,
        collapsed: next.collapsed ?? previous.collapsed,
        durationMs: next.durationMs ?? previous.durationMs,
        additions: next.additions ?? previous.additions,
        deletions: next.deletions ?? previous.deletions,
      );

  void _handleMessageDelta(Map<String, dynamic> json) {
    final sessionId = json['aiSessionId'] as String;
    final content = json['content'] as String? ?? '';
    if (content.isEmpty) return;
    final current = [...(messagesBySession[sessionId] ?? const <ChatMessage>[])];
    final pendingIndex = current.lastIndexWhere((message) => message.pending && message.role == ChatRole.assistant);
    if (pendingIndex >= 0) {
      final pending = current[pendingIndex];
      final accumulated = (pending.text ?? '') + content;
      current[pendingIndex] = pending.copyWith(text: accumulated);
    } else {
      final lastAssistantIndex = current.lastIndexWhere(
        (message) => message.role == ChatRole.assistant,
      );
      if (lastAssistantIndex >= 0 && current[lastAssistantIndex].pending) {
        final pending = current[lastAssistantIndex];
        final accumulated = (pending.text ?? '') + content;
        current[lastAssistantIndex] = pending.copyWith(text: accumulated);
      } else {
        current.add(ChatMessage(
          role: ChatRole.assistant,
          pending: true,
          text: content,
        ));
      }
    }
    messagesBySession[sessionId] = current;
  }

  void _upsertSession(AiSessionMeta session) {
    sessions = [session, ...sessions.where((item) => item.id != session.id)];
    _notifySafely();
  }

  void _appendMessage(String sessionId, ChatMessage message) {
    messagesBySession[sessionId] = [...(messagesBySession[sessionId] ?? const []), message];
    _notifySafely();
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
