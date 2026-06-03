import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

const _releasesUrl =
    'https://api.github.com/repos/gaolin89898/ai-workbench/releases';
const _openListBaseUrl = 'http://openlist.gaolin.xin';
const _openListUsername = 'ai-workbench';
const _openListReleaseDir = '/软件包/ai-workbench-releases';
const _openListManifestPath = '$_openListReleaseDir/latest.json';

class MobileUpdateInfo {
  const MobileUpdateInfo({
    required this.available,
    required this.currentVersion,
    required this.source,
    this.version,
    this.tagName,
    this.releaseUrl,
    this.apkUrl,
    this.body,
  });

  final bool available;
  final String currentVersion;
  final String source;
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

    try {
      final openListUpdate = await _checkOpenList(currentVersion);
      if (openListUpdate != null) return openListUpdate;
    } catch (_) {
      // GitHub Releases remains the fallback when OpenList is unavailable.
    }

    return _checkGitHub(currentVersion);
  }

  Future<MobileUpdateInfo?> _checkOpenList(String currentVersion) async {
    final token = await _openListToken();
    final manifestFile = await _openListFile(_openListManifestPath, token);
    if (manifestFile == null) return null;

    final manifestUrl = _openListDownloadUrl(manifestFile);
    if (manifestUrl == null) return null;

    final manifestResponse = await http.get(
      Uri.parse(manifestUrl),
      headers: _openListAuthHeaders(token),
    );
    if (manifestResponse.statusCode < 200 ||
        manifestResponse.statusCode >= 300) {
      return null;
    }

    final manifest = jsonDecode(utf8.decode(manifestResponse.bodyBytes))
        as Map<String, dynamic>;
    final latestVersion = manifest['version'] as String?;
    final tagName =
        manifest['tagName'] as String? ?? _mobileTagFromVersion(latestVersion);
    final apkPath = _openListApkPath(manifest);
    if (latestVersion == null || apkPath == null) return null;

    final apkFile = await _openListFile(apkPath, token);
    final apkUrl = apkFile == null ? null : _openListDownloadUrl(apkFile);
    final available =
        apkUrl != null && _compareVersions(latestVersion, currentVersion) > 0;

    return MobileUpdateInfo(
      available: available,
      currentVersion: currentVersion,
      source: 'OpenList',
      version: latestVersion,
      tagName: tagName,
      releaseUrl: '$_openListBaseUrl$_openListReleaseDir',
      apkUrl: apkUrl,
      body: manifest['notes'] as String?,
    );
  }

  Future<MobileUpdateInfo> _checkGitHub(String currentVersion) async {
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
      source: 'GitHub Releases',
      version: latestVersion,
      tagName: tagName,
      releaseUrl: json['html_url'] as String?,
      apkUrl: apkUrl,
      body: json['body'] as String?,
    );
  }

  Future<String> _openListToken() async {
    final response = await http.post(
      Uri.parse('$_openListBaseUrl/api/auth/login'),
      headers: const {'Content-Type': 'application/json'},
      body: jsonEncode({'username': _openListUsername}),
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('OpenList 登录返回 ${response.statusCode}');
    }
    final json = jsonDecode(response.body) as Map<String, dynamic>;
    if (json['code'] != 200) {
      throw Exception('OpenList 登录失败：${json['message']}');
    }
    final data = json['data'] as Map<String, dynamic>?;
    final token = data?['token'] as String?;
    if (token == null || token.isEmpty) {
      throw Exception('OpenList 没有返回 token');
    }
    return token;
  }

  Future<Map<String, dynamic>?> _openListFile(
    String path,
    String token,
  ) async {
    final response = await http.post(
      Uri.parse('$_openListBaseUrl/api/fs/get'),
      headers: _openListAuthHeaders(token),
      body: jsonEncode({'path': path, 'password': ''}),
    );
    if (response.statusCode < 200 || response.statusCode >= 300) return null;
    final json = jsonDecode(response.body) as Map<String, dynamic>;
    if (json['code'] != 200) return null;
    final data = json['data'];
    return data is Map<String, dynamic> ? data : null;
  }

  Map<String, String> _openListAuthHeaders(String token) {
    return {
      'Authorization': token,
      'Content-Type': 'application/json',
    };
  }

  String? _openListDownloadUrl(Map<String, dynamic> file) {
    final directUrl = file['raw_url'] as String? ?? file['d_url'] as String?;
    if (directUrl == null || directUrl.isEmpty) return null;
    if (directUrl.startsWith('http://') || directUrl.startsWith('https://')) {
      return directUrl;
    }
    return '$_openListBaseUrl$directUrl';
  }

  String? _openListApkPath(Map<String, dynamic> manifest) {
    final apkPath = manifest['apkPath'] as String?;
    if (apkPath != null && apkPath.isNotEmpty) return apkPath;

    final apkName = manifest['apkName'] as String?;
    if (apkName == null || apkName.isEmpty) return null;
    return '$_openListReleaseDir/$apkName';
  }

  String? _mobileTagFromVersion(String? version) {
    if (version == null || version.isEmpty) return null;
    return 'mobile-v$version';
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
