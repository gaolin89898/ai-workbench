import 'package:flutter_test/flutter_test.dart';
import 'package:remote_term_mobile/models/workbench_models.dart';

void main() {
  group('ChatSegment', () {
    test('parses approval segments with diff payload', () {
      final segment = ChatSegment.fromJson({
        'type': 'approval',
        'stepId': 'approval-1',
        'approvalId': 'req-123',
        'approvalKind': 'command',
        'command': 'git push --force',
        'reason': '高危命令',
        'cwd': r'C:\repo',
        'grantRoot': 'true',
        'status': 'pending',
        'providerId': 'codex',
        'message': '是否允许执行？',
        'fileChanges': ['lib/main.dart', 'pubspec.yaml'],
        'diff': '+void main() {}',
        'additions': 3,
        'deletions': 1,
        'durationMs': 1200,
        'startedAt': '2026-07-30T00:00:00Z',
      });

      expect(segment.type, 'approval');
      expect(segment.approvalId, 'req-123');
      expect(segment.approvalKind, 'command');
      expect(segment.command, 'git push --force');
      expect(segment.grantRoot, 'true');
      expect(segment.status, 'pending');
      expect(segment.diff, contains('main()'));
      expect(segment.fileChanges, hasLength(2));
      expect(segment.additions, 3);
      expect(segment.deletions, 1);
    });

    test('parses tool-call segments with input/output', () {
      final segment = ChatSegment.fromJson({
        'type': 'tool',
        'stepId': 'tool-1',
        'toolName': 'mcpToolCall',
        'title': 'read_file',
        'input': '{"path": "lib/main.dart"}',
        'output': '{"ok": true}',
        'status': 'success',
        'collapsed': false,
      });

      expect(segment.toolName, 'mcpToolCall');
      expect(segment.input, contains('main.dart'));
      expect(segment.status, 'success');
      expect(segment.collapsed, isFalse);
    });

    test('defaults type to text and tolerates missing fields', () {
      final segment = ChatSegment.fromJson({'label': '正在处理'});
      expect(segment.type, 'text');
      expect(segment.label, '正在处理');
      expect(segment.stepId, isNull);
      expect(segment.fileChanges, isEmpty);
    });
  });

  group('ActivityLog', () {
    test('parses risky and safe entries', () {
      final risky = ActivityLog.fromJson({
        'kind': 'approval',
        'title': '高危命令确认',
        'body': 'rm -rf 已被拦截',
        'risky': true,
        'createdAt': '2026-07-30T00:00:00Z',
      });
      expect(risky.kind, 'approval');
      expect(risky.risky, isTrue);
      expect(risky.body, contains('rm -rf'));

      final safe = ActivityLog.fromJson({
        'kind': 'connection',
        'title': '桌面代理已连接',
        'body': '设备上线',
        'risky': false,
        'createdAt': '2026-07-30T00:00:01Z',
      });
      expect(safe.risky, isFalse);
    });
  });

  group('UserSettings', () {
    test('parses and round-trips', () {
      final settings = UserSettings.fromJson({
        'commandLoggingEnabled': true,
        'riskConfirmationEnabled': true,
        'outputBufferLines': 500,
        'autoReconnectEnabled': false,
      });
      expect(settings.commandLoggingEnabled, isTrue);
      expect(settings.outputBufferLines, 500);
      expect(settings.autoReconnectEnabled, isFalse);

      final encoded = settings.toJson();
      expect(encoded['outputBufferLines'], 500);
    });
  });

  group('TokenUsageSummary', () {
    test('parses per-provider aggregates with totals', () {
      final summary = TokenUsageSummary.fromJson({
        'providers': [
          {
            'providerId': 'codex',
            'inputTokens': 1000,
            'outputTokens': 500,
            'reasoningTokens': 200,
            'totalTokens': 1700,
            'turnCount': 12,
          },
          {
            'providerId': 'claude',
            'inputTokens': 800,
            'outputTokens': 300,
            'reasoningTokens': 0,
            'totalTokens': 1100,
            'turnCount': 5,
          },
        ],
        'totals': {
          'inputTokens': 1800,
          'outputTokens': 800,
          'reasoningTokens': 200,
          'totalTokens': 2800,
          'turnCount': 17,
        },
      });

      expect(summary.providers, hasLength(2));
      expect(summary.providers.first.providerId, 'codex');
      expect(summary.providers.first.totalTokens, 1700);
      expect(summary.totals.totalTokens, 2800);
      expect(summary.totals.turnCount, 17);
    });

    test('tolerates missing numeric fields', () {
      final summary = TokenUsageSummary.fromJson({
        'providers': [
          {'providerId': 'mimo'},
        ],
        'totals': <String, dynamic>{},
      });
      expect(summary.providers.single.inputTokens, 0);
      expect(summary.totals.totalTokens, 0);
    });
  });

  group('DesktopDevice', () {
    test('parses online status and last-seen', () {
      final device = DesktopDevice.fromJson({
        'id': 'device-1',
        'name': 'win-machine',
        'os': 'windows',
        'online': true,
        'lastSeenAt': '2026-07-30T00:00:00Z',
      });
      expect(device.id, 'device-1');
      expect(device.name, 'win-machine');
      expect(device.online, isTrue);
      expect(device.lastSeenAt, contains('2026-07-30'));
    });
  });

  group('AiProviderTrace', () {
    test('parses trace with segments including approvals', () {
      final trace = AiProviderTrace.fromJson({
        'aiSessionId': 'session-1',
        'providerId': 'codex',
        'traceKind': 'codex',
        'status': 'running',
        'finalText': '',
        'snapshot': {
          'provider': 'codex',
          'status': 'running',
          'finalText': '',
        },
        'segments': [
          {
            'type': 'status',
            'stepId': 'runtime-status',
            'label': 'Codex running',
            'icon': 'think',
          },
          {
            'type': 'approval',
            'stepId': 'approval-1',
            'approvalId': 'req-1',
            'approvalKind': 'command',
            'command': 'git commit',
            'status': 'pending',
          },
        ],
      });
      expect(trace.providerId, 'codex');
      expect(trace.traceKind, 'codex');
      expect(trace.pending, isTrue);
      expect(trace.segments, hasLength(2));
      expect(trace.segments.last.type, 'approval');
      expect(trace.segments.last.approvalId, 'req-1');
      expect(trace.segments.last.command, 'git commit');
    });
  });
}
