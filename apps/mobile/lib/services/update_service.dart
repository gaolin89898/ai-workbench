import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

const _releasesUrl =
    'https://api.github.com/repos/gaolin89898/ai-workbench/releases';

class MobileUpdateInfo {
  const MobileUpdateInfo({
    required this.available,
    required this.currentVersion,
    this.version,
    this.tagName,
    this.releaseUrl,
    this.apkUrl,
    this.body,
  });

  final bool available;
  final String currentVersion;
  final String? version;
  final String? tagName;
  final String? releaseUrl;
  final String? apkUrl;
  final String? body;
}

class MobileUpdateService {
  const MobileUpdateService();

  Future<MobileUpdateInfo> check() async {
    final packageInfo = await PackageInfo.fromPlatform();
    final currentVersion = packageInfo.version;
    final response = await http.get(
      Uri.parse(_releasesUrl),
      headers: const {
        'Accept': 'application/vnd.github+json',
      },
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('GitHub Releases 返回 ${response.statusCode}');
    }

    final releases = jsonDecode(response.body) as List<dynamic>;
    final json = _findLatestMobileRelease(releases);
    if (json == null) {
      throw Exception('没有找到 mobile-v* Release。');
    }
    final tagName = json['tag_name'] as String? ?? '';
    final apkUrl = _findApkUrl(json['assets']);
    final latestVersion = _mobileVersionFromTag(tagName);
    final available = apkUrl != null &&
        latestVersion != null &&
        _compareVersions(latestVersion, currentVersion) > 0;

    return MobileUpdateInfo(
      available: available,
      currentVersion: currentVersion,
      version: latestVersion,
      tagName: tagName,
      releaseUrl: json['html_url'] as String?,
      apkUrl: apkUrl,
      body: json['body'] as String?,
    );
  }

  Map<String, dynamic>? _findLatestMobileRelease(List<dynamic> releases) {
    Map<String, dynamic>? latest;
    String? latestVersion;
    for (final item in releases) {
      if (item is! Map<String, dynamic>) continue;
      final tagName = item['tag_name'] as String? ?? '';
      final version = _mobileVersionFromTag(tagName);
      if (version == null || _findApkUrl(item['assets']) == null) continue;
      if (latest == null ||
          latestVersion == null ||
          _compareVersions(version, latestVersion) > 0) {
        latest = item;
        latestVersion = version;
      }
    }
    return latest;
  }

  Future<void> openDownload(MobileUpdateInfo update) async {
    final url = update.apkUrl ?? update.releaseUrl;
    if (url == null || url.isEmpty) {
      throw Exception('没有找到可下载的 APK。');
    }
    final uri = Uri.parse(url);
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened) {
      throw Exception('无法打开下载链接：$url');
    }
  }

  String? _findApkUrl(dynamic assets) {
    if (assets is! List) return null;
    for (final asset in assets) {
      if (asset is! Map<String, dynamic>) continue;
      final name = asset['name'] as String? ?? '';
      final url = asset['browser_download_url'] as String?;
      if (name.toLowerCase().endsWith('.apk') && url != null) return url;
    }
    return null;
  }

  String? _mobileVersionFromTag(String tagName) {
    if (!tagName.startsWith('mobile-v')) return null;
    return tagName.substring('mobile-v'.length).trim();
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
