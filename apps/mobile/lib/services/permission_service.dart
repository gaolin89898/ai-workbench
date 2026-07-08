import 'package:flutter/services.dart';

class PermissionService {
  static const _channel = MethodChannel('ai_workbench_mobile/permissions');

  static Future<bool> requestNotificationPermission() async {
    try {
      return await _channel.invokeMethod<bool>('requestNotificationPermission') ?? false;
    } on MissingPluginException {
      return false;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> showNotification({
    required String title,
    required String body,
  }) async {
    try {
      return await _channel.invokeMethod<bool>('showNotification', {
            'title': title,
            'body': body,
          }) ??
          false;
    } on MissingPluginException {
      return false;
    } catch (_) {
      return false;
    }
  }
}
