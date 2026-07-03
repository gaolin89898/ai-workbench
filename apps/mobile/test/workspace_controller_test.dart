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
      'text': '执行结论',
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
      '执行过程\n执行结论',
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
