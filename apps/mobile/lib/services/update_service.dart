import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

const _openListMobileFolderUrl =
    'https://openlist.gaolin.xin/%E5%A4%B8%E5%85%8B%E7%BD%91%E7%9B%98/%E7%A7%BB%E5%8A%A8%E7%AB%AF';
const _openListDavBaseUrl =
    'https://openlist.gaolin.xin/dav/%E5%A4%B8%E5%85%8B%E7%BD%91%E7%9B%98/%E7%A7%BB%E5%8A%A8%E7%AB%AF';
const _mobileManifestUrl = '$_openListDavBaseUrl/latest.json';
const _openListUser = 'admin';
const _openListPassword = '070900gl';
const _currentMobileVersion =
    String.fromEnvironment('MOBILE_VERSION', defaultValue: '0.1.27');

class MobileUpdateInfo {
  const MobileUpdateInfo({
    required this.available,
    required this.currentVersion,
    required this.source,
    required this.releaseUrl,
    this.version,
    this.tagName,
    this.apkUrl,
    this.apkFileName,
    this.body,
  });

  final bool available;
  final String currentVersion;
  final String source;
  final String releaseUrl;
  final String? version;
  final String? tagName;
  final String? apkUrl;
  final String? apkFileName;
  final String? body;
}

class MobileUpdateService {
  const MobileUpdateService();

  static const _installer = MethodChannel('ai_workbench_mobile/installer');

  Future<MobileUpdateInfo> check() async {
    final response = await http.get(
      Uri.parse(_mobileManifestUrl),
      headers: _authHeaders,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('检查更新失败：HTTP ${response.statusCode}');
    }

    final data = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    final latestVersion = data['version'] as String? ?? _currentMobileVersion;
    final apkFileName =
        data['apkFileName'] as String? ?? 'ai-workbench-mobile-$latestVersion.apk';
    final apkUrl = data['apkUrl'] as String? ?? '$_openListDavBaseUrl/$apkFileName';

    return MobileUpdateInfo(
      available: _compareVersions(latestVersion, _currentMobileVersion) > 0,
      currentVersion: _currentMobileVersion,
      source: 'OpenList',
      version: latestVersion,
      tagName: data['tagName'] as String?,
      releaseUrl: _openListMobileFolderUrl,
      apkUrl: apkUrl,
      apkFileName: apkFileName,
      body: data['notes'] as String?,
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

    final apkFileName =
        update.apkFileName ?? 'ai-workbench-mobile-${update.version ?? update.currentVersion}.apk';
    final apkFile = File('${Directory.systemTemp.path}/$apkFileName');
    final request = http.Request('GET', Uri.parse(apkUrl));
    request.headers.addAll(_authHeaders);

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

  Map<String, String> get _authHeaders => {
        'Authorization':
            'Basic ${base64Encode(utf8.encode('$_openListUser:$_openListPassword'))}',
      };

  int _compareVersions(String left, String right) {
    final leftParts = _versionParts(left);
    final rightParts = _versionParts(right);
    final length = leftParts.length > rightParts.length
        ? leftParts.length
        : rightParts.length;
    for (var index = 0; index < length; index += 1) {
      final leftValue = index < leftParts.length ? leftParts[index] : 0;
      final rightValue = index < rightParts.length ? rightParts[index] : 0;
      if (leftValue != rightValue) return leftValue.compareTo(rightValue);
    }
    return 0;
  }

  List<int> _versionParts(String version) {
    return version
        .split(RegExp(r'[.+-]'))
        .map((part) => int.tryParse(part) ?? 0)
        .toList();
  }
}
