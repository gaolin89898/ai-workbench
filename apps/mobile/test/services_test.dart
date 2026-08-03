import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:remote_term_mobile/models/workbench_models.dart';
import 'package:remote_term_mobile/services/api_client.dart';
import 'package:remote_term_mobile/services/permission_service.dart';
import 'package:remote_term_mobile/services/realtime_client.dart';
import 'package:remote_term_mobile/services/update_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final uuidPattern = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  );

  group('RealtimeClient', () {
    late RealtimeClient client;

    setUp(() {
      client = RealtimeClient(ApiClient(baseUrl: 'http://127.0.0.1:3000'));
    });

    tearDown(() async {
      await client.close();
    });

    List<Map<String, dynamic>> pendingPayloads() => client.pendingSends
        .map((raw) => jsonDecode(raw) as Map<String, dynamic>)
        .toList();

    test('requestHistory queues a well-formed payload with uuid requestId',
        () {
      client.requestHistory('device-1', 'session-1');
      final payloads = pendingPayloads();
      expect(payloads, hasLength(1));
      final payload = payloads.single;
      expect(payload['type'], 'ai.history.request');
      expect(payload['deviceId'], 'device-1');
      expect(payload['aiSessionId'], 'session-1');
      expect(payload['requestId'], matches(uuidPattern));
    });

    test('sendPrompt includes content and optional run settings', () {
      const context = ChatContextAttachment(
        id: 'path-1',
        kind: 'folder',
        name: 'auth',
        path: r'C:\repo\auth',
      );
      client.sendPrompt(
        'device-1',
        'session-1',
        '帮我看看登录',
        confirmedRisk: true,
        model: 'gpt-5.6',
        reasoningEffort: 'high',
        mode: 'plan',
        goal: '修复登录 bug',
        contexts: const [context],
      );

      final payload = pendingPayloads().single;
      expect(payload['type'], 'ai.message.send');
      expect(payload['content'], '帮我看看登录');
      expect(payload['confirmedRisk'], isTrue);
      expect(payload['model'], 'gpt-5.6');
      expect(payload['reasoningEffort'], 'high');
      expect(payload['mode'], 'plan');
      expect(payload['goal'], '修复登录 bug');
      final contexts = payload['contexts'] as List<dynamic>;
      expect(contexts, hasLength(1));
      expect((contexts.single as Map<String, dynamic>)['path'], r'C:\repo\auth');
    });

    test('sendPrompt omits empty optional fields', () {
      client.sendPrompt('device-1', 'session-1', '你好');
      final payload = pendingPayloads().single;
      expect(payload.containsKey('model'), isFalse);
      expect(payload.containsKey('contexts'), isFalse);
    });

    test('git request methods carry type, device and requestId', () {
      client.requestGitStatus('device-1', '/repo', 'req-1');
      client.requestGitCommit('device-1', '/repo', 'fix', 'req-2');
      client.requestGitPush('device-1', '/repo', 'req-3');
      client.requestGitPull('device-1', '/repo', 'req-4');

      final payloads = pendingPayloads();
      expect(payloads[0]['type'], 'git.status.request');
      expect(payloads[0]['requestId'], 'req-1');
      expect(payloads[1]['type'], 'git.commit.request');
      expect(payloads[1]['message'], 'fix');
      expect(payloads[2]['type'], 'git.push.request');
      expect(payloads[3]['type'], 'git.pull.request');
    });

    test('approval and run-settings updates are queued correctly', () {
      client.respondApproval('device-1', 'session-1', 'approval-1', 'approve');
      client.updateRunSettings('device-1', 'codex', model: 'gpt-5.6');

      final payloads = pendingPayloads();
      expect(payloads[0]['type'], 'ai.approval.respond');
      expect(payloads[0]['decision'], 'approve');
      expect(payloads[1]['type'], 'ai.run.settings.update');
      expect(payloads[1]['providerId'], 'codex');
      expect(payloads[1]['model'], 'gpt-5.6');
    });

    test('pending queue is capped at 100 messages', () {
      for (var index = 0; index < 150; index += 1) {
        client.stopPrompt('device-1', 'session-$index');
      }
      expect(client.pendingSends, hasLength(100));
    });

    test('close clears pending messages and disconnects', () async {
      client.requestHistory('device-1', 'session-1');
      await client.close();
      expect(client.pendingSends, isEmpty);
      expect(client.connected, isFalse);
    });
  });

  group('MobileUpdateInfo.fromServer', () {
    test('parses available update with apk file name derivation', () {
      final info = MobileUpdateInfo.fromServer({
        'available': true,
        'currentVersion': '0.1.99',
        'latestVersion': '0.2.0',
        'downloadUrl': 'https://example.com/app.apk',
        'releaseUrl': 'https://example.com/releases',
        'releaseNotes': '新版本',
        'required': true,
        'force': true,
      });
      expect(info.available, isTrue);
      expect(info.version, '0.2.0');
      expect(info.apkFileName, 'codehub-ai-mobile-0.2.0.apk');
      expect(info.isRequired, isTrue);
      expect(info.force, isTrue);
      expect(info.body, '新版本');
    });

    test('parses no-update response with defaults', () {
      final info = MobileUpdateInfo.fromServer({
        'available': false,
      });
      expect(info.available, isFalse);
      expect(info.version, isNull);
      expect(info.apkUrl, isNull);
      expect(info.isRequired, isFalse);
      expect(info.releaseUrl, contains('github.com'));
    });
  });

  group('PermissionService', () {
    test('falls back to false when the native channel is missing', () async {
      // Test environment has no platform implementation, so both helpers
      // must degrade gracefully instead of throwing.
      expect(await PermissionService.requestNotificationPermission(), isFalse);
      expect(
        await PermissionService.showNotification(
          title: '任务完成',
          body: 'AI 会话已结束',
        ),
        isFalse,
      );
    });
  });
}
