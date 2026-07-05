import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/workbench_models.dart';
import '../services/api_client.dart';
import '../services/realtime_client.dart';

class WorkspaceController extends ChangeNotifier {
  WorkspaceController({required this.api}) : realtime = RealtimeClient(api) {
    _persistenceLoaded = _loadPersistence();
  }

  final ApiClient api;
  final RealtimeClient realtime;
  StreamSubscription<Map<String, dynamic>>? _events;
  static const _devicesReloadInterval = Duration(seconds: 5);
  static const _historyRefreshInterval = Duration(seconds: 5);
  Timer? _historyRefreshTimer;
  String? _openSessionId;
  Future<void>? _loadDevicesInFlight;
  late final Future<void> _persistenceLoaded;
  DateTime? _lastDevicesLoadedAt;
  final Map<String, Future<AiSessionMeta?>> _createSessionInFlight = {};
  static const _selectedDeviceIdKey = 'selectedDeviceId';
  static const _accountDisplayNameKey = 'accountDisplayName';
  static const _accountAvatarIndexKey = 'accountAvatarIndex';

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
  final Map<String, String> _lastCommittedAssistantTexts = {};
  bool _notifyQueued = false;
  String? _lastSelectedDeviceId;
  String accountDisplayName = 'AI 工作台用户';
  int accountAvatarIndex = 0;

  // Client-side session state (matching desktop's localStorage pattern)
  final Set<String> _pinnedSessionIds = {};
  final Set<String> _unreadSessionIds = {};
  final Map<String, String> _localTitleOverrides = {};

  bool isSessionPinned(String sessionId) =>
      _pinnedSessionIds.contains(sessionId);
  bool isSessionUnread(String sessionId) =>
      _unreadSessionIds.contains(sessionId);
  String getEffectiveTitle(AiSessionMeta session) =>
      _localTitleOverrides[session.id] ?? session.title;

  List<AiSessionMeta> get visibleSessions {
    final filtered =
        sessions.where((s) => showArchived ? s.archived : !s.archived).toList();
    _sortSessions(filtered);
    return filtered;
  }

  List<AiSessionMeta> get dashboardRecentSessions {
    final projectIds = projects.map((project) => project.id).toSet();
    final projectPaths = projects.map((project) => project.path).toSet();
    final filtered = sessions
        .where((session) =>
            !session.archived &&
            _isVisibleAiSession(session) &&
            _belongsToCurrentProject(session, projectIds, projectPaths) &&
            _isNormalSessionStatus(session.status))
        .toList();
    _sortSessions(filtered);
    return filtered;
  }

  List<AiSessionMeta> sessionsForProject(String path) => sessions
      .where((session) =>
          session.summary == path &&
          (showArchived ? session.archived : !session.archived))
      .toList();

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
      await _persistenceLoaded;
      devices = _dedupeDevices(await api.devices());
      _lastDevicesLoadedAt = DateTime.now();
      if (selectedDevice != null) {
        selectedDevice = _findDevice(selectedDevice!.id);
      }
      selectedDevice ??= preferredInitialDevice();
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
    _lastSelectedDeviceId = device.id;
    _saveSelectedDevice();
    _notifySafely();
    await refreshWorkspace();
    _events ??= realtime.events.listen(_handleRealtime);
    realtime.connect();
  }

  DesktopDevice? preferredInitialDevice() {
    final savedDeviceId = _lastSelectedDeviceId;
    if (savedDeviceId != null && savedDeviceId.isNotEmpty) {
      final savedDevice = _findDevice(savedDeviceId);
      if (savedDevice != null) return savedDevice;
    }
    for (final device in devices) {
      if (device.online) return device;
    }
    return devices.isEmpty ? null : devices.first;
  }

  Future<void> refreshWorkspace() async {
    final device = selectedDevice;
    if (device == null) return;
    await _run(() async {
      final nextProviders = await api.providers();
      final nextProviderStatuses = await api.deviceProviders(device.id);
      final nextProjects = await api.projects(device.id);
      final nextSessions =
          _filterVisibleAiSessions(await api.aiSessions(device.id));
      final nextLogs = await api.activityLogs(deviceId: device.id);
      providers = nextProviders;
      providerStatuses = nextProviderStatuses;
      projects = nextProjects;
      sessions = nextSessions;
      logs = nextLogs;
    });
  }

  Future<AiSessionMeta?> createSession(WorkspaceProject project,
      {String providerId = 'codex'}) async {
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
      messagesBySession[session.id] = const <ChatMessage>[];
      return session;
    });
  }

  void openSession(AiSessionMeta session) {
    _openSessionId = session.id;
    messagesBySession.putIfAbsent(
      session.id,
      () => const [ChatMessage(role: ChatRole.system, text: '正在从桌面端拉取本地历史...')],
    );
    final device = selectedDevice;
    if (device != null) realtime.requestHistory(device.id, session.id);
    _startHistoryRefresh(session.id);
    markSessionRead(session.id);
    _notifySafely();
  }

  void closeSession(AiSessionMeta session) {
    if (_openSessionId != session.id) return;
    _openSessionId = null;
    _historyRefreshTimer?.cancel();
    _historyRefreshTimer = null;
  }

  void _startHistoryRefresh(String sessionId) {
    _historyRefreshTimer?.cancel();
    _historyRefreshTimer = Timer.periodic(_historyRefreshInterval, (_) {
      if (_openSessionId != sessionId) return;
      final device = selectedDevice;
      if (device == null) return;
      realtime.requestHistory(device.id, sessionId);
    });
  }

  void sendPrompt(AiSessionMeta session, String prompt) {
    final device = selectedDevice;
    final trimmed = prompt.trim();
    if (device == null || trimmed.isEmpty) return;
    if (session.archived) {
      _appendMessage(session.id,
          const ChatMessage(role: ChatRole.error, text: '这个会话已归档。请先恢复后再发送。'));
      return;
    }
    runStatusBySession[session.id] = '正在发送给 ${session.providerId}';
    _notifySafely();
    realtime.sendPrompt(device.id, session.id, trimmed);
    // Best-effort: rename untitled sessions based on the first prompt.
    _maybeRenameUntitledSession(session, trimmed);
  }

  void respondApproval(
      AiSessionMeta session, String approvalId, String decision) {
    final device = selectedDevice;
    if (device == null) return;
    if (decision != 'approved' && decision != 'denied') return;
    realtime.respondApproval(device.id, session.id, approvalId, decision);
    runStatusBySession[session.id] = decision == 'approved' ? '已同意审批' : '已拒绝审批';
    notifyListeners();
  }

  /// If the session still has the default title, derive a new title from the
  /// first prompt line and persist it via the backend PATCH endpoint. The
  /// server then forwards ai.session.rename to the desktop so its local
  /// SQLite title stays in sync.
  Future<void> _maybeRenameUntitledSession(
      AiSessionMeta session, String prompt) async {
    const untitledNames = {'新的 AI CLI 会话', '接管已有 AI CLI 会话'};
    if (!untitledNames.contains(session.title)) return;
    final firstLine = prompt
        .split(RegExp(r'\r?\n'))
        .firstWhere((line) => line.trim().isNotEmpty,
            orElse: () => '新的 AI CLI 会话')
        .trim();
    final title =
        firstLine.length > 24 ? '${firstLine.substring(0, 24)}...' : firstLine;
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

  void updateAccountProfile({
    required String displayName,
    required int avatarIndex,
  }) {
    final trimmed = displayName.trim();
    accountDisplayName = trimmed.isEmpty ? 'AI 工作台用户' : trimmed;
    accountAvatarIndex = avatarIndex < 0 ? 0 : avatarIndex;
    _saveAccountProfile();
    _notifySafely();
  }

  // --- Persistence ---

  Future<void> _loadPersistence() async {
    final prefs = await SharedPreferences.getInstance();
    _lastSelectedDeviceId = prefs.getString(_selectedDeviceIdKey);
    accountDisplayName =
        prefs.getString(_accountDisplayNameKey) ?? accountDisplayName;
    accountAvatarIndex =
        prefs.getInt(_accountAvatarIndexKey) ?? accountAvatarIndex;
    _pinnedSessionIds.addAll(prefs.getStringList('pinnedSessions') ?? []);
    _unreadSessionIds.addAll(prefs.getStringList('unreadSessions') ?? []);
    for (final entry in (prefs.getStringList('titleOverrides') ?? const [])) {
      final parts = entry.split('\x00');
      if (parts.length == 2) _localTitleOverrides[parts[0]] = parts[1];
    }
    _notifySafely();
  }

  void _saveSelectedDevice() {
    final deviceId = _lastSelectedDeviceId;
    SharedPreferences.getInstance().then((prefs) {
      if (deviceId == null || deviceId.isEmpty) {
        prefs.remove(_selectedDeviceIdKey);
      } else {
        prefs.setString(_selectedDeviceIdKey, deviceId);
      }
    });
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
      final entries = _localTitleOverrides.entries
          .map((e) => '${e.key}\x00${e.value}')
          .toList();
      prefs.setStringList('titleOverrides', entries);
    });
  }

  void _saveAccountProfile() {
    final displayName = accountDisplayName;
    final avatarIndex = accountAvatarIndex;
    SharedPreferences.getInstance().then((prefs) {
      prefs.setString(_accountDisplayNameKey, displayName);
      prefs.setInt(_accountAvatarIndexKey, avatarIndex);
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

  @visibleForTesting
  void handleRealtimeForTesting(Map<String, dynamic> json) {
    _handleRealtime(json);
  }

  void _handleRealtime(Map<String, dynamic> json) {
    final device = selectedDevice;
    if (device != null &&
        json['deviceId'] != null &&
        json['deviceId'] != device.id) {
      return;
    }
    switch (json['type']) {
      case 'desktop.heartbeat':
        if (device != null) {
          selectedDevice = device.copyWith(
              online: true, lastSeenAt: json['timestamp'] as String?);
        }
        break;
      case 'providers.snapshot':
        providerStatuses = ((json['providers'] as List<dynamic>?) ?? const [])
            .map(
                (item) => ProviderStatus.fromJson(item as Map<String, dynamic>))
            .toList();
        break;
      case 'projects.snapshot':
        projects = ((json['projects'] as List<dynamic>?) ?? const [])
            .map((item) =>
                WorkspaceProject.fromJson(item as Map<String, dynamic>))
            .toList();
        break;
      case 'ai.sessions.snapshot':
        sessions = ((json['sessions'] as List<dynamic>?) ?? const [])
            .map((item) => AiSessionMeta.fromJson(item as Map<String, dynamic>))
            .where(_isVisibleAiSession)
            .toList();
        break;
      case 'ai.history.response':
        final sessionId = json['aiSessionId'] as String;
        final current = messagesBySession[sessionId] ?? const <ChatMessage>[];
        final hasPendingAssistant = current.any(
            (message) => message.role == ChatRole.assistant && message.pending);
        final historyMessages =
            ((json['messages'] as List<dynamic>?) ?? const [])
                .whereType<Map<String, dynamic>>()
                .map((item) {
          final history = AiHistoryMessage.fromJson(item);
          return ChatMessage(
            role: history.role,
            text: history.content,
            pending: item['pending'] == true,
                segments: history.segments,
          );
        }).toList();
        final traceJson = json['trace'];
        final trace = traceJson is Map<String, dynamic>
            ? AiProviderTrace.fromJson(traceJson)
            : null;
        final mergedHistory = hasPendingAssistant
            ? _mergeHistoryWithPending(current, historyMessages)
            : historyMessages;
        messagesBySession[sessionId] = _normalizeSessionMessages(
          trace == null || !trace.isCodex
              ? mergedHistory
              : _applyProviderTraceToMessages(sessionId, mergedHistory, trace),
        );
        if (trace != null && trace.isCodex) {
          runStatusBySession[sessionId] = _codexTraceStatusLabel(trace);
        }
        break;
      case 'ai.trace.update':
        final sessionId = json['aiSessionId'] as String;
        final traceJson = json['trace'];
        if (traceJson is Map<String, dynamic>) {
          final trace = AiProviderTrace.fromJson(traceJson);
          if (trace.isCodex) {
            final current =
                messagesBySession[sessionId] ?? const <ChatMessage>[];
            messagesBySession[sessionId] = _normalizeSessionMessages(
              _applyProviderTraceToMessages(sessionId, current, trace),
            );
            runStatusBySession[sessionId] = _codexTraceStatusLabel(trace);
          }
        }
        break;
      case 'ai.chat.output':
        _handleChatOutput(json);
        break;
      case 'ai.message.delta':
        _handleMessageDelta(json);
        break;
      case 'ai.message.done':
        final sessionId = json['aiSessionId'] as String;
        final status = json['status'] as String? ?? 'idle';
        runStatusBySession[sessionId] = status;
        _handleMessageDone(sessionId, status, json['summary'] as String?);
        if (_isCompletedStatus(status)) {
          final device = selectedDevice;
          if (device != null) {
            realtime.requestHistory(device.id, sessionId);
          }
        }
        break;
      case 'terminal.error':
        final sessionId = json['aiSessionId'] as String?;
        if (sessionId != null) {
          _appendMessage(
              sessionId,
              ChatMessage(
                  role: ChatRole.error,
                  text: json['message'] as String? ?? '远程错误'));
        }
        break;
    }
    _notifySafely();
  }

  List<ChatMessage> _mergeHistoryWithPending(
    List<ChatMessage> current,
    List<ChatMessage> history,
  ) {
    final pendingIndex = current.lastIndexWhere(
      (message) => message.role == ChatRole.assistant && message.pending,
    );
    if (pendingIndex < 0) return history;
    final pending = current[pendingIndex];
    final historyHasPending = history.any(
      (message) => message.role == ChatRole.assistant && message.pending,
    );
    if (historyHasPending) return history;
    final currentPrefix = current.take(pendingIndex).toList();
    final comparableCurrentPrefix = currentPrefix
        .where((message) => message.role != ChatRole.system)
        .toList();
    if (_historyMatchesPrefix(history, comparableCurrentPrefix)) {
      final historyHasAssistantAfterCurrentPrefix =
          history.skip(comparableCurrentPrefix.length).any(
                (message) => message.role == ChatRole.assistant,
              );
      if (historyHasAssistantAfterCurrentPrefix) return history;
    }
    if (history.length >= comparableCurrentPrefix.length) {
      return [...history, pending];
    }
    return [...currentPrefix, pending];
  }

  String _codexTraceStatusLabel(AiProviderTrace trace) {
    switch (trace.status) {
      case 'running':
        return 'Codex 正在执行';
      case 'failed':
        return 'Codex 执行失败';
      case 'canceled':
        return 'Codex 已取消';
      case 'completed':
        return 'Codex 已完成';
      default:
        return trace.status.isEmpty ? 'Codex 状态未知' : 'Codex ${trace.status}';
    }
  }

  List<ChatMessage> _applyProviderTraceToMessages(
    String sessionId,
    List<ChatMessage> messages,
    AiProviderTrace trace,
  ) {
    final text = trace.displayText;
    final segments = trace.segments;
    if (text.isEmpty && segments.isEmpty) return messages;
    final traceMessage = ChatMessage(
      role: ChatRole.assistant,
      pending: trace.pending,
      text: text.isEmpty ? null : text,
      segments: segments,
    );
    final next = [...messages];
    final pendingIndex = next.lastIndexWhere(
      (message) => message.role == ChatRole.assistant && message.pending,
    );
    if (pendingIndex >= 0) {
      next[pendingIndex] = traceMessage;
      if (!trace.pending) {
        _currentAgentMessageStepIds.remove(sessionId);
        _lastCommittedAssistantTexts.remove(sessionId);
      }
      return next;
    }
    final assistantIndex = next.lastIndexWhere(
      (message) => message.role == ChatRole.assistant,
    );
    if (assistantIndex >= 0) {
      final previous = next[assistantIndex];
      next[assistantIndex] = ChatMessage(
        role: ChatRole.assistant,
        pending: trace.pending,
        text: text.isEmpty ? previous.text : text,
        segments: segments.isEmpty ? previous.segments : segments,
      );
      return next;
    }
    next.add(traceMessage);
    return next;
  }

  bool _historyMatchesPrefix(
    List<ChatMessage> history,
    List<ChatMessage> prefix,
  ) {
    if (history.length < prefix.length) return false;
    for (var index = 0; index < prefix.length; index += 1) {
      if (!_areDuplicateChatMessages(history[index], prefix[index])) {
        return false;
      }
    }
    return true;
  }

  List<ChatMessage> _normalizeSessionMessages(List<ChatMessage> messages) {
    return _dedupeAdjacentMessages(
      _mergeAdjacentAssistantTurnMessages(
        _mergePendingAssistantMessages(messages),
      ),
    );
  }

  List<ChatMessage> _mergePendingAssistantMessages(List<ChatMessage> messages) {
    final merged = <ChatMessage>[];
    var pendingAssistantIndex = -1;

    for (final message in messages) {
      if (message.role != ChatRole.assistant || !message.pending) {
        merged.add(message);
        continue;
      }

      if (pendingAssistantIndex < 0) {
        pendingAssistantIndex = merged.length;
        merged.add(message);
        continue;
      }

      final previous = merged[pendingAssistantIndex];
      merged[pendingAssistantIndex] = ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        text: _mergeAssistantText(previous.text, message.text),
        segments: _mergeSegments(previous.segments, message.segments),
      );
    }

    return merged;
  }

  List<ChatMessage> _mergeAdjacentAssistantTurnMessages(
    List<ChatMessage> messages,
  ) {
    final merged = <ChatMessage>[];
    for (final message in messages) {
      final previous = merged.isEmpty ? null : merged.last;
      if (previous != null &&
          previous.role == ChatRole.assistant &&
          message.role == ChatRole.assistant) {
        merged[merged.length - 1] =
            _mergeAssistantTurnMessage(previous, message);
        continue;
      }
      merged.add(message);
    }
    return merged;
  }

  ChatMessage _mergeAssistantTurnMessage(ChatMessage left, ChatMessage right) {
    return ChatMessage(
      role: ChatRole.assistant,
      pending: _mergedAssistantPending(left, right),
      text: _mergeAssistantText(left.text, right.text),
      segments: _mergeSegments(left.segments, right.segments),
    );
  }

  bool _mergedAssistantPending(ChatMessage left, ChatMessage right) {
    if (right.pending) return true;
    if (_assistantVisibleText(right).isNotEmpty) return false;
    return left.pending;
  }

  String? _mergeAssistantText(String? left, String? right) {
    final a = left ?? '';
    final b = right ?? '';
    if (a.isEmpty) return b.isEmpty ? null : b;
    if (b.isEmpty) return a;

    final normalizedA = _normalizeAssistantDisplayText(a);
    final normalizedB = _normalizeAssistantDisplayText(b);
    if (normalizedA == normalizedB) return a.length >= b.length ? a : b;
    if (b.startsWith(a)) return b;
    if (a.startsWith(b)) return a;
    return '$a$b';
  }

  List<ChatMessage> _dedupeAdjacentMessages(List<ChatMessage> messages) {
    final deduped = <ChatMessage>[];
    for (final message in messages) {
      final previous = deduped.isEmpty ? null : deduped.last;
      if (previous != null && _areDuplicateChatMessages(previous, message)) {
        if (_chatMessageScore(message) > _chatMessageScore(previous)) {
          deduped[deduped.length - 1] = message;
        }
        continue;
      }
      deduped.add(message);
    }
    return deduped;
  }

  bool _areDuplicateChatMessages(ChatMessage left, ChatMessage right) {
    if (left.role != right.role) return false;
    if (left.role != ChatRole.assistant) {
      return _chatMessageFingerprint(left) == _chatMessageFingerprint(right);
    }
    return _areDuplicateAssistantDisplays(
      _assistantVisibleText(left),
      _assistantVisibleText(right),
    );
  }

  String _assistantVisibleText(ChatMessage message) {
    return _stripProcessTextFromFinalText(message.text ?? '', message.segments);
  }

  bool _areDuplicateAssistantDisplays(String left, String right) {
    final a = _normalizeAssistantDisplayText(left);
    final b = _normalizeAssistantDisplayText(right);
    if (a.isEmpty || b.isEmpty) return false;
    if (a == b) return true;
    final shorter = a.length <= b.length ? a : b;
    final longer = a.length <= b.length ? b : a;
    if (shorter.length >= 80 && longer.startsWith(shorter)) return true;
    if (shorter.length < 160) return false;
    return _commonPrefixLength(shorter, longer) / shorter.length >= 0.86;
  }

  String _normalizeAssistantDisplayText(String text) {
    return text.replaceAll(RegExp(r'\s+'), ' ').trim();
  }

  int _commonPrefixLength(String left, String right) {
    final limit = left.length < right.length ? left.length : right.length;
    var index = 0;
    while (index < limit && left[index] == right[index]) {
      index += 1;
    }
    return index;
  }

  String _chatMessageFingerprint(ChatMessage message) {
    final text = message.role == ChatRole.assistant
        ? _assistantVisibleText(message)
        : (message.text ?? '').trim();
    return '${message.role.name}\u0000$text';
  }

  int _chatMessageScore(ChatMessage message) {
    var score = (message.text ?? '').length + message.segments.length * 100;
    if (message.segments.any((segment) => segment.stepId == 'final-summary')) {
      score += 10000;
    }
    return score;
  }

  String _stripProcessTextFromFinalText(
    String text,
    List<ChatSegment> sourceSegments,
  ) {
    var cleaned = text.trim();
    if (cleaned.isEmpty) return cleaned;
    for (final segment in sourceSegments) {
      if (!_isProcessTextSegment(segment)) continue;
      cleaned = _removeTextBlock(cleaned, segment.text ?? '');
      if (cleaned.isEmpty) break;
    }
    return cleaned.trim();
  }

  bool _isProcessTextSegment(ChatSegment segment) {
    final stepId = segment.stepId ?? '';
    return segment.type == 'text' &&
        (stepId.startsWith('process-text-') ||
            stepId.startsWith('thought-') ||
            stepId.startsWith('commentary-'));
  }

  String _processTextStepId(String? stepId) {
    final normalized = (stepId ?? '').trim();
    return 'process-text-${normalized.isEmpty ? 'agent-message' : normalized}';
  }

  List<ChatSegment> _appendProcessTextSegment(
    List<ChatSegment> source,
    String? stepId,
    String text,
  ) {
    final targetStepId = _processTextStepId(stepId);
    final index =
        source.indexWhere((segment) => segment.stepId == targetStepId);
    if (index < 0) {
      return [
        ...source,
        ChatSegment(type: 'text', stepId: targetStepId, text: text),
      ];
    }

    final next = [...source];
    final previous = next[index];
    next[index] = ChatSegment(
      type: previous.type,
      stepId: previous.stepId,
      text: (previous.text ?? '') + text,
      label: previous.label,
      detail: previous.detail,
      icon: previous.icon,
      title: previous.title,
      toolName: previous.toolName,
      command: previous.command,
      status: previous.status,
      summary: previous.summary,
      input: previous.input,
      output: previous.output,
      diff: previous.diff,
      message: previous.message,
      approvalId: previous.approvalId,
      approvalKind: previous.approvalKind,
      reason: previous.reason,
      cwd: previous.cwd,
      grantRoot: previous.grantRoot,
      fileChanges: previous.fileChanges,
      collapsed: previous.collapsed,
      durationMs: previous.durationMs,
      additions: previous.additions,
      deletions: previous.deletions,
    );
    return next;
  }

  String _latestProcessText(List<ChatSegment> segments) {
    for (var index = segments.length - 1; index >= 0; index -= 1) {
      final segment = segments[index];
      if (!_isProcessTextSegment(segment)) continue;
      final text = segment.text?.trim() ?? '';
      if (text.isNotEmpty) return text;
    }
    return '';
  }

  List<ChatSegment> _removeMatchingProcessText(
    List<ChatSegment> segments,
    String text,
  ) {
    final target = text.trim();
    if (target.isEmpty) return segments;
    return segments
        .where((segment) =>
            !_isProcessTextSegment(segment) ||
            (segment.text ?? '').trim() != target)
        .toList();
  }

  String _removeTextBlock(String text, String block) {
    final target = block.trim();
    var source = text.trim();
    if (target.isEmpty || source.isEmpty) return source;
    if (source == target) return '';
    if (source.startsWith(target)) {
      return source.substring(target.length).trimLeft();
    }
    final surrounded = '\n\n$target\n\n';
    final index = source.indexOf(surrounded);
    if (index >= 0) {
      source =
          '${source.substring(0, index)}\n\n${source.substring(index + surrounded.length)}';
    }
    return source.trim();
  }

  void _handleChatOutput(Map<String, dynamic> json) {
    final sessionId = json['aiSessionId'] as String;
    final kind = json['kind'] as String? ?? 'status';
    final phase = json['phase'] as String?;
    final text = json['text'] as String?;
    final segmentJson = json['segment'] as Map<String, dynamic>?;
    final segment = segmentJson == null
        ? null
        : _normalizeIncomingSegment(ChatSegment.fromJson(segmentJson));
    final segments = ((json['segments'] as List<dynamic>?) ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(ChatSegment.fromJson)
        .map(_normalizeIncomingSegment)
        .toList();
    final current = [
      ...(messagesBySession[sessionId] ?? const <ChatMessage>[])
    ];
    final pendingIndex = current.lastIndexWhere(
        (message) => message.pending && message.role == ChatRole.assistant);
    if (kind == 'done') {
      final pending = pendingIndex >= 0 ? current[pendingIndex] : null;
      final incomingSegments = [
        ...segments,
        if (segment != null) segment,
      ];
      final mergedSegments = pending == null
          ? incomingSegments
          : _mergeSegments(pending.segments, incomingSegments);
      final explicitText = text?.trim() ?? '';
      final pendingText = pending?.text?.trim() ?? '';
      final processText = _latestProcessText(mergedSegments);
      final doneText = explicitText.isNotEmpty
          ? explicitText
          : (pendingText.isNotEmpty ? pendingText : processText);
      final doneSegments = doneText.isEmpty
          ? mergedSegments
          : _removeMatchingProcessText(mergedSegments, doneText);
      final done = ChatMessage(
        role: ChatRole.assistant,
        text: doneText.isEmpty ? null : doneText,
        segments: doneSegments,
      );
      if (pendingIndex >= 0) {
        current[pendingIndex] = done;
      } else if (doneText.isNotEmpty || doneSegments.isNotEmpty) {
        final lastAssistantIndex = current.lastIndexWhere(
          (message) => message.role == ChatRole.assistant,
        );
        if (lastAssistantIndex >= 0 &&
            _shouldMergeDoneIntoAssistant(current[lastAssistantIndex])) {
          final previous = current[lastAssistantIndex];
          current[lastAssistantIndex] = ChatMessage(
            role: ChatRole.assistant,
            text: doneText.isEmpty ? previous.text : doneText,
            segments: _mergeSegments(previous.segments, doneSegments),
          );
        } else {
          current.add(done);
        }
      }
      runStatusBySession[sessionId] = '已完成';
      _currentAgentMessageStepIds.remove(sessionId);
      _lastCommittedAssistantTexts.remove(sessionId);
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
      _currentAgentMessageStepIds.remove(sessionId);
      _lastCommittedAssistantTexts.remove(sessionId);
    } else if (kind == 'delta') {
      final deltaText =
          (text != null && text.isNotEmpty) ? text : segment?.text;
      final deltaStepId = json['stepId'] as String?;
      final currentStepId = _currentAgentMessageStepIds[sessionId];
      final processStepId = deltaStepId ?? currentStepId ?? segment?.stepId;
      final isStepChange = deltaStepId != null && deltaStepId != currentStepId;
      var incomingSegments = [
        ...segments,
        if (segment != null) segment,
      ];
      final isProcessDelta = phase == 'process';
      if (isStepChange) {
        _currentAgentMessageStepIds[sessionId] = deltaStepId;
      }
      if (pendingIndex >= 0) {
        final pending = current[pendingIndex];
        final accumulated =
            isProcessDelta || deltaText == null || deltaText.isEmpty
                ? pending.text
                : (pending.text ?? '') + deltaText;
        var nextSegments = _mergeSegments(pending.segments, incomingSegments);
        if (isProcessDelta && deltaText != null && deltaText.isNotEmpty) {
          nextSegments =
              _appendProcessTextSegment(nextSegments, processStepId, deltaText);
        }
        current[pendingIndex] = pending.copyWith(
          text: accumulated,
          segments: nextSegments,
        );
      } else {
        final lastAssistantIndex = current.lastIndexWhere(
          (message) => message.role == ChatRole.assistant,
        );
        if (lastAssistantIndex >= 0 && current[lastAssistantIndex].pending) {
          final pending = current[lastAssistantIndex];
          final accumulated =
              isProcessDelta || deltaText == null || deltaText.isEmpty
                  ? pending.text
                  : (pending.text ?? '') + deltaText;
          var nextSegments = _mergeSegments(pending.segments, incomingSegments);
          if (isProcessDelta && deltaText != null && deltaText.isNotEmpty) {
            nextSegments = _appendProcessTextSegment(
              nextSegments,
              processStepId,
              deltaText,
            );
          }
          current[lastAssistantIndex] = pending.copyWith(
            text: accumulated,
            segments: nextSegments,
          );
        } else if ((deltaText ?? '').isNotEmpty ||
            incomingSegments.isNotEmpty) {
          if (isProcessDelta && deltaText != null && deltaText.isNotEmpty) {
            incomingSegments = _appendProcessTextSegment(
              incomingSegments,
              processStepId,
              deltaText,
            );
          }
          current.add(ChatMessage(
            role: ChatRole.assistant,
            pending: true,
            text: isProcessDelta ? null : deltaText,
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
          _normalizeIncomingSegment(
            ChatSegment(
              type: 'status',
              label: text ?? 'AI 正在执行',
              icon: 'think',
            ),
          ),
      ];
      final hasProcessSegment = incomingSegments.any(_isProcessChatSegment);
      if (pendingIndex >= 0) {
        final pending = current[pendingIndex];
        final committedSegments = hasProcessSegment
            ? _commitCurrentTextAsThought(sessionId, pending)
            : const <ChatSegment>[];
        current[pendingIndex] = pending.copyWith(
          text: _textAfterCommittedProcessText(pending.text, committedSegments),
          segments: _mergeSegments(pending.segments, [
            ...committedSegments,
            ...incomingSegments,
          ]),
        );
      } else {
        final lastAssistantIndex = current.lastIndexWhere(
          (message) => message.role == ChatRole.assistant,
        );
        if (lastAssistantIndex >= 0 && current[lastAssistantIndex].pending) {
          final pending = current[lastAssistantIndex];
          final committedSegments = hasProcessSegment
              ? _commitCurrentTextAsThought(sessionId, pending)
              : const <ChatSegment>[];
          current[lastAssistantIndex] = pending.copyWith(
            text:
                _textAfterCommittedProcessText(pending.text, committedSegments),
            segments: _mergeSegments(pending.segments, [
              ...committedSegments,
              ...incomingSegments,
            ]),
          );
        } else {
          current.add(ChatMessage(
            role: ChatRole.assistant,
            pending: true,
            segments: incomingSegments,
          ));
        }
      }
      runStatusBySession[sessionId] = text ??
          (incomingSegments.isEmpty ? null : incomingSegments.last.label) ??
          'AI 正在执行';
    }
    messagesBySession[sessionId] = _normalizeSessionMessages(current);
  }

  ChatSegment _normalizeIncomingSegment(ChatSegment segment) {
    if (segment.stepId != null && segment.stepId!.isNotEmpty) return segment;
    if (segment.type != 'status') return segment;
    final label = (segment.label ?? segment.text ?? '').trim();
    if (_isRuntimeStatusLabel(label)) {
      return _copySegmentWithStepId(segment, 'runtime-status');
    }
    if (_isThinkingStatusLabel(label)) {
      return _copySegmentWithStepId(segment, 'thinking-status');
    }
    return segment;
  }

  ChatSegment _copySegmentWithStepId(ChatSegment segment, String stepId) {
    return ChatSegment(
      type: segment.type,
      stepId: stepId,
      text: segment.text,
      label: segment.label,
      detail: segment.detail,
      icon: segment.icon,
      title: segment.title,
      toolName: segment.toolName,
      command: segment.command,
      status: segment.status,
      summary: segment.summary,
      input: segment.input,
      output: segment.output,
      diff: segment.diff,
      message: segment.message,
      approvalId: segment.approvalId,
      approvalKind: segment.approvalKind,
      reason: segment.reason,
      cwd: segment.cwd,
      grantRoot: segment.grantRoot,
      fileChanges: segment.fileChanges,
      collapsed: segment.collapsed,
      durationMs: segment.durationMs,
      additions: segment.additions,
      deletions: segment.deletions,
      rawItemType: segment.rawItemType,
      startedAt: segment.startedAt,
    );
  }

  bool _isRuntimeStatusLabel(String label) {
    return label == 'running' ||
        label == '正在处理' ||
        label == 'AI 正在执行' ||
        label == 'Codex 正在执行' ||
        label == 'Claude 正在执行';
  }

  bool _isThinkingStatusLabel(String label) {
    return label == '正在思考' ||
        label == '思考中' ||
        label == 'Codex 正在思考' ||
        label == 'Claude 正在思考';
  }

  void _handleMessageDone(String sessionId, String status, String? summary) {
    final current = [
      ...(messagesBySession[sessionId] ?? const <ChatMessage>[])
    ];
    final pendingIndex = current.lastIndexWhere(
      (message) => message.pending && message.role == ChatRole.assistant,
    );
    if (pendingIndex < 0) return;

    final pending = current[pendingIndex];
    if (_isFailureStatus(status)) {
      current[pendingIndex] = ChatMessage(
        role: ChatRole.error,
        text: summary == null || summary.isEmpty ? 'AI 执行失败' : summary,
        segments: pending.segments,
      );
      _currentAgentMessageStepIds.remove(sessionId);
      _lastCommittedAssistantTexts.remove(sessionId);
    } else if (_isCompletedStatus(status)) {
      // The completion event means the desktop run ended, but the final
      // assistant text may still arrive through ai.chat.output or history.
      // Keep the pending message open so the final answer can merge into it.
      _currentAgentMessageStepIds.remove(sessionId);
    }
    messagesBySession[sessionId] = _normalizeSessionMessages(current);
  }

  bool _shouldMergeDoneIntoAssistant(ChatMessage message) {
    if (message.pending) return true;
    if (message.role != ChatRole.assistant) return false;
    if (_assistantVisibleText(message).isNotEmpty) return false;
    return message.segments.any(_isProcessChatSegment);
  }

  bool _isCompletedStatus(String status) {
    final normalized = status.trim().toLowerCase();
    return normalized == 'completed' ||
        normalized == 'complete' ||
        normalized == 'done' ||
        normalized == 'success' ||
        normalized == 'idle';
  }

  bool _isFailureStatus(String status) {
    final normalized = status.trim().toLowerCase();
    return normalized == 'failed' ||
        normalized == 'failure' ||
        normalized == 'error';
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

  List<ChatSegment> _commitCurrentTextAsThought(
    String sessionId,
    ChatMessage pending,
  ) {
    final currentStepId = _currentAgentMessageStepIds[sessionId];
    final prevText = (pending.text ?? '').trim();
    if (currentStepId == null ||
        prevText.isEmpty ||
        prevText == _lastCommittedAssistantTexts[sessionId] ||
        !_looksLikeProcessCommentary(prevText)) {
      return const [];
    }
    _lastCommittedAssistantTexts[sessionId] = prevText;
    return [
      ChatSegment(
        type: 'thought',
        stepId: 'thought-$currentStepId',
        title: '中间结论',
        text: prevText,
        collapsed: true,
      ),
    ];
  }

  String? _textAfterCommittedProcessText(
    String? currentText,
    List<ChatSegment> committedSegments,
  ) {
    if (committedSegments.isEmpty) return currentText;
    final current = currentText ?? '';
    final committed = (committedSegments.first.text ?? '').trim();
    if (committed.isEmpty) return currentText;
    if (current.trim() == committed) return '';
    if (current.startsWith(committed)) {
      return current.substring(committed.length).trimLeft();
    }
    return currentText;
  }

  bool _isProcessChatSegment(ChatSegment segment) {
    return segment.type == 'tool' ||
        segment.type == 'status' ||
        segment.type == 'thought' ||
        segment.type == 'error' ||
        segment.type == 'approval';
  }

  bool _looksLikeProcessCommentary(String text) {
    final normalized = text.trim();
    if (normalized.length < 8) return false;
    return RegExp(r'^(我先|先|接下来|现在我|我会|我准备|我需要|我将|我来|先看|先检查|正在)')
            .hasMatch(normalized) ||
        RegExp(r'(接下来我|我先看|我会先|我将先|先确认|先检查|先读取|先看一下)').hasMatch(normalized) ||
        RegExp(r'''^(Let me|I('|’)ll|I am going to|I'm going to)\b''',
                caseSensitive: false)
            .hasMatch(normalized);
  }

  List<ChatSegment> _mergeSegment(
      List<ChatSegment> source, ChatSegment segment) {
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
  ) =>
      ChatSegment(
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
        approvalId: next.approvalId ?? previous.approvalId,
        approvalKind: next.approvalKind ?? previous.approvalKind,
        reason: next.reason ?? previous.reason,
        cwd: next.cwd ?? previous.cwd,
        grantRoot: next.grantRoot ?? previous.grantRoot,
        fileChanges: next.fileChanges.isNotEmpty
            ? next.fileChanges
            : previous.fileChanges,
        collapsed: next.collapsed ?? previous.collapsed,
        durationMs: next.durationMs ?? previous.durationMs,
        additions: next.additions ?? previous.additions,
        deletions: next.deletions ?? previous.deletions,
        rawItemType: next.rawItemType ?? previous.rawItemType,
        startedAt: next.startedAt ?? previous.startedAt,
      );

  void _handleMessageDelta(Map<String, dynamic> json) {
    final sessionId = json['aiSessionId'] as String;
    final content = json['content'] as String? ?? '';
    if (content.isEmpty) return;
    final current = [
      ...(messagesBySession[sessionId] ?? const <ChatMessage>[])
    ];
    final pendingIndex = current.lastIndexWhere(
        (message) => message.pending && message.role == ChatRole.assistant);
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
    messagesBySession[sessionId] = _normalizeSessionMessages(current);
  }

  void _upsertSession(AiSessionMeta session) {
    sessions = [session, ...sessions.where((item) => item.id != session.id)];
    _notifySafely();
  }

  void _appendMessage(String sessionId, ChatMessage message) {
    messagesBySession[sessionId] = [
      ...(messagesBySession[sessionId] ?? const []),
      message
    ];
    _notifySafely();
  }

  DesktopDevice? _findDevice(String id) {
    for (final device in devices) {
      if (device.id == id) return device;
    }
    return null;
  }

  List<DesktopDevice> _dedupeDevices(List<DesktopDevice> source) {
    final byDisplayIdentity = <String, DesktopDevice>{};
    for (final device in source) {
      final key = _deviceDisplayIdentity(device);
      final existing = byDisplayIdentity[key];
      if (existing == null || _isPreferredDevice(device, existing)) {
        byDisplayIdentity[key] = device;
      }
    }
    return byDisplayIdentity.values.toList()
      ..sort((a, b) {
        if (a.online != b.online) return a.online ? -1 : 1;
        final aSeen = _parseDeviceSeenAt(a.lastSeenAt);
        final bSeen = _parseDeviceSeenAt(b.lastSeenAt);
        if (aSeen != null && bSeen != null) return bSeen.compareTo(aSeen);
        if (aSeen != null) return -1;
        if (bSeen != null) return 1;
        return a.name.compareTo(b.name);
      });
  }

  String _deviceDisplayIdentity(DesktopDevice device) {
    final name = device.name.trim().toLowerCase();
    final os = device.os.trim().toLowerCase();
    return '$name\x1f$os';
  }

  bool _isPreferredDevice(DesktopDevice candidate, DesktopDevice current) {
    if (candidate.online != current.online) return candidate.online;
    final candidateSeen = _parseDeviceSeenAt(candidate.lastSeenAt);
    final currentSeen = _parseDeviceSeenAt(current.lastSeenAt);
    if (candidateSeen != null && currentSeen != null) {
      return candidateSeen.isAfter(currentSeen);
    }
    if (candidateSeen != null) return true;
    return false;
  }

  DateTime? _parseDeviceSeenAt(String? value) {
    if (value == null || value.isEmpty) return null;
    return DateTime.tryParse(value);
  }

  List<AiSessionMeta> _filterVisibleAiSessions(List<AiSessionMeta> source) =>
      source.where(_isVisibleAiSession).toList();

  bool _isVisibleAiSession(AiSessionMeta session) {
    final providerSessionId = session.providerSessionId;
    return session.providerId != 'codex' ||
        providerSessionId == null ||
        providerSessionId.startsWith('app-server:');
  }

  bool _belongsToCurrentProject(
    AiSessionMeta session,
    Set<String> projectIds,
    Set<String> projectPaths,
  ) {
    final projectId = session.projectId;
    if (projectId != null && projectIds.contains(projectId)) return true;
    final summary = session.summary;
    return summary != null && projectPaths.contains(summary);
  }

  bool _isNormalSessionStatus(String status) {
    switch (status.trim().toLowerCase()) {
      case 'failed':
      case 'failure':
      case 'error':
        return false;
      default:
        return true;
    }
  }

  void _sortSessions(List<AiSessionMeta> items) {
    // Sort: pinned first, then by updatedAt desc
    items.sort((a, b) {
      final aPinned = _pinnedSessionIds.contains(a.id) ? 0 : 1;
      final bPinned = _pinnedSessionIds.contains(b.id) ? 0 : 1;
      if (aPinned != bPinned) return aPinned.compareTo(bPinned);
      return b.updatedAt.compareTo(a.updatedAt);
    });
  }

  @override
  void dispose() {
    _historyRefreshTimer?.cancel();
    _events?.cancel();
    realtime.close();
    super.dispose();
  }
}
