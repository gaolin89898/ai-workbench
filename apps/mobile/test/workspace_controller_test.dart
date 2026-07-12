import 'package:flutter_test/flutter_test.dart';
import 'package:remote_term_mobile/models/workbench_models.dart';
import 'package:remote_term_mobile/services/api_client.dart';
import 'package:remote_term_mobile/state/workspace_controller.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('run settings snapshot supports OpenCode and MiMo', () {
    final snapshot = AiRunSettingsSnapshot.fromJson({
      'deviceId': 'device-1',
      'codex': {'providerId': 'codex'},
      'claude': {'providerId': 'claude'},
      'opencode': {
        'providerId': 'opencode',
        'model': 'openai/gpt-5.6',
        'reasoningEffort': 'high',
        'models': [
          {
            'id': 'openai/gpt-5.6',
            'model': 'openai/gpt-5.6',
            'displayName': 'GPT-5.6',
          },
        ],
        'reasoningOptions': ['medium', 'high'],
      },
      'mimo': {
        'providerId': 'mimo',
        'model': 'xiaomi/mimo-v2.5-pro',
        'reasoningEffort': 'high',
        'models': [
          {
            'id': 'xiaomi/mimo-v2.5-pro',
            'model': 'xiaomi/mimo-v2.5-pro',
            'displayName': 'MiMo-V2.5-Pro',
          },
        ],
        'reasoningOptions': ['low', 'high'],
      },
    });

    expect(snapshot.forProvider('opencode')?.model, 'openai/gpt-5.6');
    expect(snapshot.forProvider('opencode')?.reasoningOptions, ['medium', 'high']);
    expect(snapshot.forProvider('mimo')?.model, 'xiaomi/mimo-v2.5-pro');
  });

  test('structured history restores chat contexts', () {
    final history = AiHistoryMessage.fromJson({
      'role': 'user',
      'createdAt': '2026-07-12T00:00:00Z',
      'content': {
        'text': '检查登录逻辑',
        'contexts': [
          {
            'id': 'path-1',
            'kind': 'folder',
            'name': 'auth',
            'path': r'C:\repo\auth',
          },
          {
            'id': 'code-1',
            'kind': 'code',
            'name': 'login.dart',
            'path': r'C:\repo\auth\login.dart',
            'content': 'Future<void> login() async {}',
            'startLine': 10,
            'endLine': 10,
            'language': 'dart',
          },
        ],
      },
    });

    expect(history.contexts, hasLength(2));
    expect(history.contexts.first.kind, 'folder');
    expect(history.contexts.last.content, contains('login'));
    expect(history.contexts.last.startLine, 10);
  });

  test('selected model survives a stale run settings snapshot', () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.selectedDevice = const DesktopDevice(
      id: 'device-1',
      name: 'desktop',
      os: 'windows',
      online: true,
    );

    Map<String, dynamic> snapshot(String model) => {
          'type': 'ai.run.settings.snapshot',
          'deviceId': 'device-1',
          'codex': {
            'providerId': 'codex',
            'model': model,
            'reasoningEffort': 'high',
            'models': [
              {
                'id': 'gpt-5.6',
                'model': 'gpt-5.6',
                'displayName': 'GPT-5.6',
              },
              {
                'id': 'gpt-5.6-codex',
                'model': 'gpt-5.6-codex',
                'displayName': 'GPT-5.6 Codex',
              },
            ],
            'reasoningOptions': ['medium', 'high'],
          },
          'claude': {'providerId': 'claude'},
        };

    controller.handleRealtimeForTesting(snapshot('gpt-5.6'));
    controller.updateRunSettings('codex', model: 'gpt-5.6-codex');
    expect(controller.selectedRunSettings?.codex.model, 'gpt-5.6-codex');

    controller.handleRealtimeForTesting(snapshot('gpt-5.6'));
    expect(controller.selectedRunSettings?.codex.model, 'gpt-5.6-codex');

    controller.handleRealtimeForTesting(snapshot('gpt-5.6-codex'));
    controller.handleRealtimeForTesting(snapshot('gpt-5.6'));
    expect(controller.selectedRunSettings?.codex.model, 'gpt-5.6');

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('project file response models parse preview payloads', () {
    final entry = WorkspaceFileEntry.fromJson({
      'name': 'main.dart',
      'path': r'C:\repo\lib\main.dart',
      'kind': 'file',
      'size': 128,
      'modifiedAt': '2026-07-10T00:00:00Z',
    });
    final preview = ProjectFilePreview.fromJson({
      'name': 'main.dart',
      'path': entry.path,
      'size': entry.size,
      'modifiedAt': entry.modifiedAt,
      'previewKind': 'text',
      'content': 'void main() {}',
      'language': 'dart',
    });

    expect(entry.isDirectory, isFalse);
    expect(preview.previewKind, 'text');
    expect(preview.content, contains('main'));
  });

  test(
      'history response replaces realtime pending when assistant history exists',
      () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '你好'),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [
          ChatSegment(type: 'status', label: '正在处理', icon: 'think'),
        ],
      ),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.history.response',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'requestId': 'request-1',
      'messages': [
        {
          'role': 'user',
          'content': '你好',
          'createdAt': '2026-07-03T00:00:00Z',
        },
        {
          'role': 'assistant',
          'content': '你好，我在。',
          'createdAt': '2026-07-03T00:00:01Z',
        },
      ],
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    expect(messages.last.role, ChatRole.assistant);
    expect(messages.last.pending, isFalse);
    expect(messages.last.text, '你好，我在。');

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('open session shows history timeout when desktop does not respond',
      () async {
    final controller = WorkspaceController(
      api: ApiClient(baseUrl: 'http://127.0.0.1:3000'),
      historyRequestTimeout: const Duration(milliseconds: 1),
    );
    controller.selectedDevice = const DesktopDevice(
      id: 'device-1',
      name: 'desktop',
      os: 'linux',
      online: true,
    );

    controller.openSession(
      const AiSessionMeta(
        id: 'session-1',
        deviceId: 'device-1',
        providerId: 'codex',
        title: '历史会话',
        status: 'idle',
        updatedAt: '2026-07-03T00:00:00Z',
      ),
    );

    await Future<void>.delayed(const Duration(milliseconds: 20));

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(1));
    expect(messages.single.role, ChatRole.error);
    expect(messages.single.text, contains('桌面端'));

    controller.dispose();
  });

  test('loadDevices keeps same-name desktop devices visible', () async {
    final controller = WorkspaceController(
      api: _FakeDeviceApiClient([
        const DesktopDevice(
          id: 'old-offline',
          name: 'dev-machine',
          os: 'windows',
          online: false,
          lastSeenAt: '2026-07-03T00:00:00Z',
        ),
        const DesktopDevice(
          id: 'current-online',
          name: 'dev-machine',
          os: 'windows',
          online: true,
          lastSeenAt: '2026-07-04T00:00:00Z',
        ),
        const DesktopDevice(
          id: 'other-device',
          name: 'other-machine',
          os: 'windows',
          online: false,
          lastSeenAt: '2026-07-02T00:00:00Z',
        ),
      ]),
    );

    await controller.loadDevices();

    expect(controller.devices.map((device) => device.id), [
      'current-online',
      'old-offline',
      'other-device',
    ]);

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('history response preserves realtime pending before history catches up',
      () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '你好'),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [
          ChatSegment(type: 'status', label: '正在处理', icon: 'think'),
        ],
      ),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.history.response',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'requestId': 'request-1',
      'messages': [
        {
          'role': 'user',
          'content': '你好',
          'createdAt': '2026-07-03T00:00:00Z',
        },
      ],
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    expect(messages.first.role, ChatRole.user);
    expect(messages.last.role, ChatRole.assistant);
    expect(messages.last.pending, isTrue);

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('codex history trace replaces pending assistant shell', () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '改一下移动端展示'),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [
          ChatSegment(type: 'status', label: '正在处理', icon: 'think'),
        ],
      ),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.history.response',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'requestId': 'request-1',
      'messages': [
        {
          'role': 'user',
          'content': '改一下移动端展示',
          'createdAt': '2026-07-03T00:00:00Z',
        },
      ],
      'trace': {
        'aiSessionId': 'session-1',
        'providerId': 'codex',
        'traceKind': 'codex',
        'status': 'running',
        'finalText': '',
        'snapshot': {
          'provider': 'codex',
          'status': 'running',
          'items': [],
          'approvals': [],
          'errors': [],
          'finalText': '',
          'updatedAt': '2026-07-03T00:00:01Z',
        },
        'segments': [
          {
            'type': 'status',
            'stepId': 'runtime-status',
            'label': 'Codex 正在执行',
            'icon': 'think',
          },
        ],
      },
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    expect(messages.last.role, ChatRole.assistant);
    expect(messages.last.pending, isTrue);
    expect(messages.last.segments, hasLength(1));
    expect(messages.last.segments.single.stepId, 'runtime-status');

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('codex trace update completes without creating second assistant',
      () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '改一下移动端展示'),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [
          ChatSegment(
            type: 'status',
            stepId: 'runtime-status',
            label: 'Codex 正在执行',
            icon: 'think',
          ),
        ],
      ),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.trace.update',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'trace': {
        'aiSessionId': 'session-1',
        'providerId': 'codex',
        'traceKind': 'codex',
        'status': 'completed',
        'finalText': '已经改成统一会话外壳。',
        'snapshot': {
          'provider': 'codex',
          'status': 'completed',
          'items': [],
          'approvals': [],
          'errors': [],
          'finalText': '已经改成统一会话外壳。',
          'updatedAt': '2026-07-03T00:00:02Z',
        },
        'segments': [
          {
            'type': 'status',
            'stepId': 'final-summary',
            'label': '已处理',
          },
        ],
      },
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    expect(messages.last.role, ChatRole.assistant);
    expect(messages.last.pending, isFalse);
    expect(messages.last.text, '已经改成统一会话外壳。');
    expect(messages.last.segments.single.stepId, 'final-summary');

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('message done keeps realtime pending open for final output', () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '你好'),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [
          ChatSegment(
            type: 'status',
            stepId: 'mobile-run-started',
            label: '正在处理',
            icon: 'think',
          ),
        ],
      ),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.message.done',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'status': 'completed',
      'summary': null,
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    expect(messages.last.role, ChatRole.assistant);
    expect(messages.last.pending, isTrue);
    expect(messages.last.text, isNull);

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('chat output done merges into assistant after message done', () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '你好'),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [
          ChatSegment(
            type: 'status',
            stepId: 'mobile-run-started',
            label: '正在处理',
            icon: 'think',
          ),
        ],
      ),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.message.done',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'status': 'completed',
      'summary': null,
    });
    controller.handleRealtimeForTesting({
      'type': 'ai.chat.output',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'kind': 'done',
      'text': '你好，我在。',
      'segments': [
        {
          'type': 'status',
          'stepId': 'final-summary',
          'label': '已处理 1秒',
          'durationMs': 1000,
        },
      ],
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    expect(messages.last.role, ChatRole.assistant);
    expect(messages.last.pending, isFalse);
    expect(messages.last.text, '你好，我在。');
    expect(
      messages.last.segments
          .where((segment) =>
              segment.type == 'status' && segment.stepId == 'final-summary')
          .length,
      1,
    );

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('process deltas stay in process segments before final answer', () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '用户问题'),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.chat.output',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'kind': 'delta',
      'phase': 'process',
      'stepId': 'agent-message',
      'text': '执行过程\n',
    });
    controller.handleRealtimeForTesting({
      'type': 'ai.chat.output',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'kind': 'delta',
      'phase': 'process',
      'stepId': 'agent-message',
      'text': '已完成',
    });
    controller.handleRealtimeForTesting({
      'type': 'ai.chat.output',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'kind': 'done',
      'phase': 'final',
      'text': '最终回答',
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    final assistant = messages.last;
    expect(assistant.role, ChatRole.assistant);
    expect(assistant.pending, isFalse);
    expect(assistant.text, '最终回答');
    expect(
      assistant.segments
          .where((segment) =>
              segment.type == 'text' &&
              segment.stepId == 'process-text-agent-message')
          .single
          .text,
      '执行过程\n已完成',
    );

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('empty done promotes latest process text instead of clearing reply',
      () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '用户问题'),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.chat.output',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'kind': 'delta',
      'phase': 'process',
      'stepId': 'agent-message',
      'text': '这是兜底回答',
    });
    controller.handleRealtimeForTesting({
      'type': 'ai.chat.output',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'kind': 'done',
      'phase': 'final',
      'text': '',
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    final assistant = messages.last;
    expect(assistant.role, ChatRole.assistant);
    expect(assistant.pending, isFalse);
    expect(assistant.text, '这是兜底回答');
    expect(
      assistant.segments.any((segment) =>
          segment.type == 'text' &&
          segment.stepId == 'process-text-agent-message'),
      isFalse,
    );

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('empty done keeps accumulated final delta visible', () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '用户问题'),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.chat.output',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'kind': 'delta',
      'phase': 'final',
      'text': '最终回答',
    });
    controller.handleRealtimeForTesting({
      'type': 'ai.chat.output',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'kind': 'done',
      'phase': 'final',
      'text': '',
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    expect(messages.last.role, ChatRole.assistant);
    expect(messages.last.pending, isFalse);
    expect(messages.last.text, '最终回答');

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('realtime status and text pending assistants stay as one reply',
      () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '你好'),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [
          ChatSegment(
            type: 'status',
            stepId: 'mobile-run-started',
            label: '正在处理',
            icon: 'think',
          ),
        ],
      ),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        text: '我正在检查项目。',
      ),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.message.done',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'status': 'completed',
      'summary': null,
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    expect(messages.last.role, ChatRole.assistant);
    expect(messages.last.pending, isTrue);
    expect(messages.last.text, '我正在检查项目。');
    expect(
      messages.last.segments.any((segment) =>
          segment.type == 'status' && segment.stepId == 'mobile-run-started'),
      isTrue,
    );

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('completed and pending assistant cards in one turn stay as one reply',
      () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '你好'),
      ChatMessage(
        role: ChatRole.assistant,
        segments: [
          ChatSegment(
            type: 'status',
            stepId: 'final-summary',
            label: '已处理',
            icon: 'check',
          ),
        ],
      ),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [
          ChatSegment(
            type: 'status',
            stepId: 'mobile-run-started',
            label: '正在处理',
            icon: 'think',
          ),
        ],
      ),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.message.done',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'status': 'completed',
      'summary': null,
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    expect(messages.last.role, ChatRole.assistant);
    expect(messages.last.pending, isTrue);
    expect(
      messages.last.segments.any((segment) =>
          segment.type == 'status' && segment.stepId == 'final-summary'),
      isTrue,
    );
    expect(
      messages.last.segments.any((segment) =>
          segment.type == 'status' && segment.stepId == 'mobile-run-started'),
      isTrue,
    );

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('sendPrompt creates a local turn separator for follow-up prompts',
      () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.selectedDevice = const DesktopDevice(
      id: 'device-1',
      name: 'desktop',
      os: 'windows',
      online: true,
    );
    final session = const AiSessionMeta(
      id: 'session-1',
      deviceId: 'device-1',
      providerId: 'codex',
      title: 'Existing session',
      status: 'completed',
      updatedAt: '2026-07-03T00:00:00Z',
    );
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: 'first'),
      ChatMessage(role: ChatRole.assistant, text: 'first answer'),
    ];

    controller.sendPrompt(session, 'second');

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(4));
    expect(messages[0].text, 'first');
    expect(messages[1].text, 'first answer');
    expect(messages[2].role, ChatRole.user);
    expect(messages[2].text, 'second');
    expect(messages[3].role, ChatRole.assistant);
    expect(messages[3].pending, isTrue);

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('sendPrompt accepts project context without prompt text', () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.selectedDevice = const DesktopDevice(
      id: 'device-1',
      name: 'desktop',
      os: 'windows',
      online: true,
    );
    const session = AiSessionMeta(
      id: 'session-1',
      deviceId: 'device-1',
      providerId: 'codex',
      title: 'Existing session',
      status: 'completed',
      updatedAt: '2026-07-03T00:00:00Z',
    );
    const context = ChatContextAttachment(
      id: 'path-1',
      kind: 'folder',
      name: 'auth',
      path: r'C:\repo\auth',
    );

    controller.sendPrompt(session, '', contexts: const [context]);

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    expect(messages.first.role, ChatRole.user);
    expect(messages.first.text, isEmpty);
    expect(messages.first.contexts.single.path, r'C:\repo\auth');
    expect(messages.last.pending, isTrue);

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('codex trace update belongs to the latest user turn', () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: 'first'),
      ChatMessage(role: ChatRole.assistant, text: 'first answer'),
      ChatMessage(role: ChatRole.user, text: 'second'),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.trace.update',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'trace': {
        'aiSessionId': 'session-1',
        'providerId': 'codex',
        'traceKind': 'codex',
        'status': 'running',
        'finalText': '',
        'snapshot': {
          'provider': 'codex',
          'status': 'running',
          'items': [],
          'approvals': [],
          'errors': [],
          'finalText': '',
          'updatedAt': '2026-07-03T00:00:02Z',
        },
        'segments': [
          {
            'type': 'status',
            'stepId': 'runtime-status',
            'label': 'Codex running',
            'icon': 'think',
          },
        ],
      },
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(4));
    expect(messages[1].text, 'first answer');
    expect(messages[2].role, ChatRole.user);
    expect(messages[3].role, ChatRole.assistant);
    expect(messages[3].pending, isTrue);
    expect(messages[3].segments.single.stepId, 'runtime-status');

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('pending assistants separated by a user turn are not merged', () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: 'first'),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [
          ChatSegment(type: 'status', stepId: 'first-run', label: 'first'),
        ],
      ),
      ChatMessage(role: ChatRole.user, text: 'second'),
      ChatMessage(
        role: ChatRole.assistant,
        pending: true,
        segments: [
          ChatSegment(type: 'status', stepId: 'second-run', label: 'second'),
        ],
      ),
    ];

    controller.handleRealtimeForTesting({
      'type': 'ai.message.done',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'status': 'completed',
      'summary': null,
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(4));
    expect(messages[1].segments.single.stepId, 'first-run');
    expect(messages[3].segments.single.stepId, 'second-run');

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });

  test('runtime status is stable and thinking status is preserved', () async {
    final controller =
        WorkspaceController(api: ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    controller.messagesBySession['session-1'] = const [
      ChatMessage(role: ChatRole.user, text: '你好'),
    ];

    for (var index = 0; index < 3; index += 1) {
      controller.handleRealtimeForTesting({
        'type': 'ai.chat.output',
        'deviceId': 'device-1',
        'aiSessionId': 'session-1',
        'kind': 'status',
        'text': 'running',
        'segment': {
          'type': 'status',
          'label': 'Codex 正在执行',
          'icon': 'think',
        },
      });
    }
    controller.handleRealtimeForTesting({
      'type': 'ai.chat.output',
      'deviceId': 'device-1',
      'aiSessionId': 'session-1',
      'kind': 'step-start',
      'stepId': 'reasoning-1',
      'segment': {
        'type': 'status',
        'stepId': 'reasoning-1',
        'label': '正在思考',
        'icon': 'think',
      },
    });

    final messages = controller.messagesBySession['session-1']!;
    expect(messages, hasLength(2));
    final assistant = messages.last;
    expect(assistant.role, ChatRole.assistant);
    expect(
      assistant.segments
          .where((segment) =>
              segment.type == 'status' && segment.stepId == 'runtime-status')
          .length,
      1,
    );
    expect(
      assistant.segments.any((segment) =>
          segment.type == 'status' &&
          segment.stepId == 'reasoning-1' &&
          segment.label == '正在思考'),
      isTrue,
    );

    await Future<void>.delayed(Duration.zero);
    controller.dispose();
  });
}

class _FakeDeviceApiClient extends ApiClient {
  _FakeDeviceApiClient(this._devices) : super(baseUrl: 'http://127.0.0.1:3000');

  final List<DesktopDevice> _devices;

  @override
  Future<List<DesktopDevice>> devices() async => _devices;
}
