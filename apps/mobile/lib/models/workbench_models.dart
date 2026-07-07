import 'dart:convert';

enum ChatRole { user, assistant, system, error }

ChatRole chatRoleFromString(String value) {
  return switch (value) {
    'user' => ChatRole.user,
    'assistant' => ChatRole.assistant,
    'error' => ChatRole.error,
    _ => ChatRole.system,
  };
}

String chatRoleToString(ChatRole role) {
  return switch (role) {
    ChatRole.user => 'user',
    ChatRole.assistant => 'assistant',
    ChatRole.system => 'system',
    ChatRole.error => 'error',
  };
}

class DesktopDevice {
  const DesktopDevice({
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

  factory DesktopDevice.fromJson(Map<String, dynamic> json) => DesktopDevice(
        id: json['id'] as String,
        name: json['name'] as String,
        os: json['os'] as String,
        online: json['online'] as bool,
        lastSeenAt: json['lastSeenAt'] as String?,
      );

  DesktopDevice copyWith({bool? online, String? lastSeenAt}) => DesktopDevice(
        id: id,
        name: name,
        os: os,
        online: online ?? this.online,
        lastSeenAt: lastSeenAt ?? this.lastSeenAt,
      );
}

class AiProvider {
  const AiProvider({
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

  factory AiProvider.fromJson(Map<String, dynamic> json) => AiProvider(
        id: json['id'] as String,
        name: json['name'] as String,
        command: json['command'] as String,
        builtIn: json['builtIn'] as bool,
        enabled: json['enabled'] as bool,
      );
}

class ProviderStatus {
  const ProviderStatus({
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

  factory ProviderStatus.fromJson(Map<String, dynamic> json) => ProviderStatus(
        providerId: json['providerId'] as String,
        installed: json['installed'] as bool,
        authStatus: json['authStatus'] as String,
        lastCheckedAt: json['lastCheckedAt'] as String,
        version: json['version'] as String?,
      );
}

class WorkspaceProject {
  const WorkspaceProject({
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

  factory WorkspaceProject.fromJson(Map<String, dynamic> json) =>
      WorkspaceProject(
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
  const AiSessionMeta({
    required this.id,
    required this.deviceId,
    required this.providerId,
    required this.title,
    required this.status,
    required this.updatedAt,
    this.projectId,
    this.terminalSessionId,
    this.providerSessionId,
    this.summary,
    this.archivedAt,
  });

  final String id;
  final String deviceId;
  final String providerId;
  final String title;
  final String status;
  final String updatedAt;
  final String? projectId;
  final String? terminalSessionId;
  final String? providerSessionId;
  final String? summary;
  final String? archivedAt;

  bool get archived => archivedAt != null;

  factory AiSessionMeta.fromJson(Map<String, dynamic> json) => AiSessionMeta(
        id: json['id'] as String,
        deviceId: json['deviceId'] as String,
        providerId: json['providerId'] as String,
        title: json['title'] as String,
        status: json['status'] as String,
        updatedAt: json['updatedAt'] as String,
        projectId: json['projectId'] as String?,
        terminalSessionId: json['terminalSessionId'] as String?,
        providerSessionId: json['providerSessionId'] as String?,
        summary: json['summary'] as String?,
        archivedAt: json['archivedAt'] as String?,
      );
}

class AiHistoryMessage {
  const AiHistoryMessage({
    required this.role,
    required this.content,
    required this.createdAt,
    this.segments = const [],
  });

  static const _structuredMessagePrefix = '__AI_WORKBENCH_MESSAGE_V1__';

  final ChatRole role;
  final String content;
  final String createdAt;
  final List<ChatSegment> segments;

  factory AiHistoryMessage.fromJson(Map<String, dynamic> json) {
    final rawContent = json['content'];
    final structuredContent = _decodeStructuredContent(rawContent);
    if (structuredContent != null) {
      return AiHistoryMessage(
        role: chatRoleFromString(json['role'] as String),
        content: structuredContent.text,
        createdAt: json['createdAt'] as String,
        segments: structuredContent.segments,
      );
    }
    return AiHistoryMessage(
      role: chatRoleFromString(json['role'] as String),
      content: rawContent as String? ?? '',
      createdAt: json['createdAt'] as String,
    );
  }

  static _StructuredHistoryContent? _decodeStructuredContent(
      dynamic rawContent) {
    try {
      final content = rawContent is String &&
              rawContent.startsWith(_structuredMessagePrefix)
          ? jsonDecode(
              rawContent.substring(_structuredMessagePrefix.length),
            )
          : rawContent;
      if (content is! Map<String, dynamic>) return null;
      return _StructuredHistoryContent(
        text: content['text'] as String? ?? '',
        segments: ((content['segments'] as List<dynamic>?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(ChatSegment.fromJson)
            .toList(),
      );
    } catch (_) {
      return null;
    }
  }
}

class _StructuredHistoryContent {
  const _StructuredHistoryContent({required this.text, required this.segments});

  final String text;
  final List<ChatSegment> segments;
}

class ChatSegment {
  const ChatSegment({
    required this.type,
    this.stepId,
    this.text,
    this.label,
    this.detail,
    this.icon,
    this.title,
    this.toolName,
    this.command,
    this.status,
    this.summary,
    this.input,
    this.output,
    this.diff,
    this.message,
    this.approvalId,
    this.approvalKind,
    this.reason,
    this.cwd,
    this.grantRoot,
    this.fileChanges = const [],
    this.collapsed,
    this.durationMs,
    this.additions,
    this.deletions,
    this.rawItemType,
    this.startedAt,
  });

  final String type;
  final String? stepId;
  final String? text;
  final String? label;
  final String? detail;
  final String? icon;
  final String? title;
  final String? toolName;
  final String? command;
  final String? status;
  final String? summary;
  final String? input;
  final String? output;
  final String? diff;
  final String? message;
  final String? approvalId;
  final String? approvalKind;
  final String? reason;
  final String? cwd;
  final String? grantRoot;
  final List<String> fileChanges;
  final bool? collapsed;
  final int? durationMs;
  final int? additions;
  final int? deletions;
  final String? rawItemType;
  final String? startedAt;

  factory ChatSegment.fromJson(Map<String, dynamic> json) => ChatSegment(
        type: json['type'] as String? ?? 'text',
        stepId: json['stepId'] as String?,
        text: json['text'] as String?,
        label: json['label'] as String?,
        detail: json['detail'] as String?,
        icon: json['icon'] as String?,
        title: json['title'] as String?,
        toolName: json['toolName'] as String?,
        command: json['command'] as String?,
        status: json['status'] as String?,
        summary: json['summary'] as String?,
        input: json['input'] as String?,
        output: json['output'] as String?,
        diff: json['diff'] as String?,
        message: json['message'] as String?,
        approvalId: json['approvalId'] as String?,
        approvalKind: json['approvalKind'] as String?,
        reason: json['reason'] as String?,
        cwd: json['cwd'] as String?,
        grantRoot: json['grantRoot'] as String?,
        fileChanges: ((json['fileChanges'] as List<dynamic>?) ?? const [])
            .whereType<String>()
            .toList(),
        collapsed: json['collapsed'] as bool?,
        durationMs: json['durationMs'] as int?,
        additions: json['additions'] as int?,
        deletions: json['deletions'] as int?,
        rawItemType: json['rawItemType'] as String?,
        startedAt: json['startedAt'] as String?,
      );
}

class AiProviderTrace {
  const AiProviderTrace({
    required this.aiSessionId,
    required this.providerId,
    required this.traceKind,
    required this.status,
    required this.snapshot,
    this.finalText,
    this.segments = const [],
  });

  final String aiSessionId;
  final String providerId;
  final String traceKind;
  final String status;
  final Map<String, dynamic> snapshot;
  final String? finalText;
  final List<ChatSegment> segments;

  bool get isCodex => providerId == 'codex' && traceKind == 'codex';
  bool get pending => status == 'running';

  String get displayText {
    final explicit = finalText?.trim() ?? '';
    if (explicit.isNotEmpty) return explicit;
    final snapshotText = snapshot['finalText'];
    return snapshotText is String ? snapshotText.trim() : '';
  }

  factory AiProviderTrace.fromJson(Map<String, dynamic> json) =>
      AiProviderTrace(
        aiSessionId: json['aiSessionId'] as String? ?? '',
        providerId: json['providerId'] as String? ?? '',
        traceKind: json['traceKind'] as String? ?? '',
        status: json['status'] as String? ?? 'idle',
        snapshot: (json['snapshot'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{},
        finalText: json['finalText'] as String?,
        segments: ((json['segments'] as List<dynamic>?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(ChatSegment.fromJson)
            .toList(),
      );
}

class ChatMessage {
  const ChatMessage({
    required this.role,
    this.text,
    this.pending = false,
    this.segments = const [],
  });

  final ChatRole role;
  final String? text;
  final bool pending;
  final List<ChatSegment> segments;

  ChatMessage copyWith({
    ChatRole? role,
    String? text,
    bool? pending,
    List<ChatSegment>? segments,
  }) =>
      ChatMessage(
        role: role ?? this.role,
        text: text ?? this.text,
        pending: pending ?? this.pending,
        segments: segments ?? this.segments,
      );
}

class ActivityLog {
  const ActivityLog({
    required this.kind,
    required this.title,
    required this.body,
    required this.risky,
    required this.createdAt,
  });

  final String kind;
  final String title;
  final String body;
  final bool risky;
  final String createdAt;

  factory ActivityLog.fromJson(Map<String, dynamic> json) => ActivityLog(
        kind: json['kind'] as String,
        title: json['title'] as String,
        body: json['body'] as String,
        risky: json['risky'] as bool,
        createdAt: json['createdAt'] as String,
      );
}

class UserSettings {
  const UserSettings({
    required this.commandLoggingEnabled,
    required this.riskConfirmationEnabled,
    required this.outputBufferLines,
    required this.autoReconnectEnabled,
  });

  final bool commandLoggingEnabled;
  final bool riskConfirmationEnabled;
  final int outputBufferLines;
  final bool autoReconnectEnabled;

  factory UserSettings.fromJson(Map<String, dynamic> json) => UserSettings(
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
}

/// 单个 AI 工具的 Token 用量聚合。
class TokenUsageSummaryItem {
  const TokenUsageSummaryItem({
    required this.providerId,
    required this.inputTokens,
    required this.outputTokens,
    required this.reasoningTokens,
    required this.totalTokens,
    required this.turnCount,
  });

  final String providerId;
  final int inputTokens;
  final int outputTokens;
  final int reasoningTokens;
  final int totalTokens;
  final int turnCount;

  factory TokenUsageSummaryItem.fromJson(Map<String, dynamic> json) =>
      TokenUsageSummaryItem(
        providerId: json['providerId'] as String? ?? '',
        inputTokens: (json['inputTokens'] as num?)?.toInt() ?? 0,
        outputTokens: (json['outputTokens'] as num?)?.toInt() ?? 0,
        reasoningTokens: (json['reasoningTokens'] as num?)?.toInt() ?? 0,
        totalTokens: (json['totalTokens'] as num?)?.toInt() ?? 0,
        turnCount: (json['turnCount'] as num?)?.toInt() ?? 0,
      );
}

/// 所有 AI 工具的 Token 用量汇总。
class TokenUsageSummary {
  const TokenUsageSummary({required this.providers, required this.totals});

  final List<TokenUsageSummaryItem> providers;
  final TokenUsageSummaryItem totals;

  factory TokenUsageSummary.fromJson(Map<String, dynamic> json) =>
      TokenUsageSummary(
        providers: ((json['providers'] as List<dynamic>?) ?? const [])
            .map((e) =>
                TokenUsageSummaryItem.fromJson(e as Map<String, dynamic>))
            .toList(),
        totals: TokenUsageSummaryItem.fromJson(
          (json['totals'] as Map<String, dynamic>?) ?? const {},
        ),
      );
}
