import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

const _openListMobileFolderUrl =
    'https://openlist.gaolin.xin/%E5%A4%B8%E5%85%8B%E7%BD%91%E7%9B%98/%E7%A7%BB%E5%8A%A8%E7%AB%AF';
const _mobileApkFileName = 'ai-workbench-mobile-0.1.26.apk';
const _mobileApkUrl =
    'https://openlist.gaolin.xin/dav/%E5%A4%B8%E5%85%8B%E7%BD%91%E7%9B%98/%E7%A7%BB%E5%8A%A8%E7%AB%AF/$_mobileApkFileName';
const _openListUser = 'admin';
const _openListPassword = '070900gl';
const _currentMobileVersion =
    String.fromEnvironment('MOBILE_VERSION', defaultValue: '0.1.26');

class MobileUpdateInfo {
  const MobileUpdateInfo({
    required this.available,
    required this.currentVersion,
    required this.source,
    required this.releaseUrl,
    this.version,
    this.tagName,
    this.apkUrl,
    this.body,
  });

  final bool available;
  final String currentVersion;
  final String source;
  final String releaseUrl;
  final String? version;
  final String? tagName;
  final String? apkUrl;
  final String? body;
}

class MobileUpdateService {
  const MobileUpdateService();

  static const _installer = MethodChannel('ai_workbench_mobile/installer');

  Future<MobileUpdateInfo> check() async {
    return const MobileUpdateInfo(
      available: true,
      currentVersion: _currentMobileVersion,
      source: 'OpenList',
      version: '0.1.26',
      releaseUrl: _openListMobileFolderUrl,
      apkUrl: _mobileApkUrl,
      body: '移动端安装包将从 OpenList 直接下载并安装。',
    );
  }

  Future<void> downloadAndInstall(
    MobileUpdateInfo update, {
    void Function(int received, int? total)? onProgress,
  }) async {
    final apkUrl = update.apkUrl;
    if (apkUrl == null || apkUrl.isEmpty) {
      throw Exception('没有可下载的 APK 地址。');
    }

    final apkFile = File('${Directory.systemTemp.path}/$_mobileApkFileName');
    final request = http.Request('GET', Uri.parse(apkUrl));
    request.headers['Authorization'] =
        'Basic ${base64Encode(utf8.encode('$_openListUser:$_openListPassword'))}';

    final response = await request.send();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('下载 APK 失败：HTTP ${response.statusCode}');
    }

    final sink = apkFile.openWrite();
    var received = 0;
    final total = response.contentLength;
    try {
      await for (final chunk in response.stream) {
        received += chunk.length;
        sink.add(chunk);
        onProgress?.call(received, total);
      }
    } finally {
      await sink.close();
    }

    if (!Platform.isAndroid) {
      throw Exception('当前平台不支持自动安装 APK。');
    }

    await _installer.invokeMethod<void>('installApk', {'path': apkFile.path});
  }

  Future<void> openDownload(MobileUpdateInfo update) async {
    final url = update.apkUrl ?? update.releaseUrl;
    final uri = Uri.parse(url);
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened) {
      throw Exception('无法打开下载链接：$url');
    }
  }
}
