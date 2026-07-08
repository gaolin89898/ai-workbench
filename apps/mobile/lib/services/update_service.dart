import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import 'api_client.dart';

const _githubReleasesApiUrl =
    'https://api.github.com/repos/gaolin89898/ai-workbench/releases?per_page=30';
const _githubReleasesUrl =
    'https://github.com/gaolin89898/ai-workbench/releases';
const _currentMobileVersion =
    String.fromEnvironment('MOBILE_VERSION', defaultValue: '0.1.76');
const _downloadHeaders = {
  'Accept':
      'application/octet-stream, application/vnd.android.package-archive, */*',
  'User-Agent': 'AI-Workbench-Mobile-Updater',
};

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
    this.isRequired = false,
    this.force = false,
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
  final bool isRequired;
  final bool force;

  factory MobileUpdateInfo.fromServer(Map<String, dynamic> json) {
    final latestVersion = json['latestVersion'] as String?;
    final downloadUrl = json['downloadUrl'] as String?;
    final releaseUrl = json['releaseUrl'] as String? ?? _githubReleasesUrl;
    return MobileUpdateInfo(
      available: json['available'] == true,
      currentVersion: json['currentVersion'] as String? ??
          MobileUpdateService.currentVersion,
      source: json['source'] as String? ?? '服务端',
      releaseUrl: releaseUrl,
      version: latestVersion,
      apkUrl: downloadUrl,
      apkFileName: latestVersion == null
          ? null
          : 'ai-workbench-mobile-$latestVersion.apk',
      body: json['releaseNotes'] as String?,
      isRequired: json['required'] == true,
      force: json['force'] == true,
    );
  }
}

class MobileUpdateService {
  const MobileUpdateService();

  static const currentVersion = _currentMobileVersion;
  static const _installer = MethodChannel('ai_workbench_mobile/installer');

  Future<MobileUpdateInfo> check({ApiClient? api}) async {
    if (api != null) {
      try {
        final release = await api.appRelease(
          platform: 'mobile',
          currentVersion: _currentMobileVersion,
        );
        final info = MobileUpdateInfo.fromServer(release);
        return info;
      } catch (_) {
        // Fall back to GitHub Releases below.
      }
    }

    final response = await http.get(
      Uri.parse(_githubReleasesApiUrl),
      headers: const {'Accept': 'application/vnd.github+json'},
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('检查 GitHub Releases 失败：HTTP ${response.statusCode}');
    }

    final releases =
        jsonDecode(utf8.decode(response.bodyBytes)) as List<dynamic>;
    final release = _latestMobileRelease(releases);
    if (release == null) {
      throw Exception('GitHub Releases 中没有找到移动端安装包。');
    }
    final assets = (release['assets'] as List<dynamic>? ?? const []);
    final apkAsset = assets.cast<Map<String, dynamic>?>().firstWhere(
          (asset) => (asset?['name'] as String? ?? '').endsWith('.apk'),
          orElse: () => null,
        );
    if (apkAsset == null) {
      throw Exception('GitHub Release 中没有 APK 资产。');
    }

    final tagName = release['tag_name'] as String? ?? '';
    final latestVersion =
        _mobileVersionFromTag(tagName) ?? _currentMobileVersion;
    final apkFileName =
        apkAsset['name'] as String? ?? 'ai-workbench-mobile-$latestVersion.apk';
    final apkUrl = apkAsset['browser_download_url'] as String?;
    if (apkUrl == null || apkUrl.isEmpty) {
      throw Exception('GitHub Release APK 缺少下载地址。');
    }

    return MobileUpdateInfo(
      available: _compareVersions(latestVersion, _currentMobileVersion) > 0,
      currentVersion: _currentMobileVersion,
      source: 'GitHub Releases',
      version: latestVersion,
      tagName: tagName,
      releaseUrl: release['html_url'] as String? ?? _githubReleasesUrl,
      apkUrl: apkUrl,
      apkFileName: apkFileName,
      body: release['body'] as String?,
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

    final apkFileName = update.apkFileName ??
        'ai-workbench-mobile-${update.version ?? update.currentVersion}.apk';
    final safeApkFileName =
        apkFileName.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
    final tempDir = Directory.systemTemp;
    if (!await tempDir.exists()) {
      await tempDir.create(recursive: true);
    }
    final apkFile = File('${tempDir.path}/$safeApkFileName');
    if (await apkFile.exists()) {
      await apkFile.delete();
    }

    final request = http.Request('GET', Uri.parse(apkUrl))
      ..headers.addAll(_downloadHeaders);
    final client = http.Client();
    try {
      final response = await client.send(request);
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

      if (received <= 0 ||
          !await apkFile.exists() ||
          await apkFile.length() <= 0) {
        throw Exception('下载 APK 失败：文件为空');
      }
    } catch (_) {
      if (await apkFile.exists()) {
        await apkFile.delete();
      }
      rethrow;
    } finally {
      client.close();
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

  Map<String, dynamic>? _latestMobileRelease(List<dynamic> releases) {
    for (final item in releases) {
      if (item is! Map<String, dynamic>) continue;
      if (item['draft'] == true || item['prerelease'] == true) continue;
      final tagName = item['tag_name'] as String? ?? '';
      if (!tagName.startsWith('v') && !tagName.startsWith('mobile-v')) {
        continue;
      }
      final assets = item['assets'] as List<dynamic>? ?? const [];
      final hasApk = assets.any((asset) {
        return asset is Map<String, dynamic> &&
            (asset['name'] as String? ?? '').endsWith('.apk');
      });
      if (hasApk) return item;
    }
    return null;
  }

  String? _mobileVersionFromTag(String tagName) {
    final match = RegExp(r'^(?:mobile-)?v(.+)$').firstMatch(tagName);
    return match?.group(1);
  }

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
