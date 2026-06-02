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

class PairingCode {
  const PairingCode({required this.code, required this.expiresAt});

  final String code;
  final String expiresAt;

  factory PairingCode.fromJson(Map<String, dynamic> json) => PairingCode(
        code: json['code'] as String,
        expiresAt: json['expiresAt'] as String,
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

  factory WorkspaceProject.fromJson(Map<String, dynamic> json) => WorkspaceProject(
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
  });

  final ChatRole role;
  final String content;
  final String createdAt;

  factory AiHistoryMessage.fromJson(Map<String, dynamic> json) => AiHistoryMessage(
        role: chatRoleFromString(json['role'] as String),
        content: json['content'] as String,
        createdAt: json['createdAt'] as String,
      );
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
    this.message,
    this.additions,
    this.deletions,
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
  final String? message;
  final int? additions;
  final int? deletions;

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
        message: json['message'] as String?,
        additions: json['additions'] as int?,
        deletions: json['deletions'] as int?,
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
