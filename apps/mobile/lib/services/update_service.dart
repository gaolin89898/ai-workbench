import 'package:url_launcher/url_launcher.dart';

const _openListMobileUrl =
    'https://openlist.gaolin.xin/%E5%A4%B8%E5%85%8B%E7%BD%91%E7%9B%98/%E7%A7%BB%E5%8A%A8%E7%AB%AF';
const _currentMobileVersion =
    String.fromEnvironment('MOBILE_VERSION', defaultValue: '0.1.22');

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

  Future<MobileUpdateInfo> check() async {
    return const MobileUpdateInfo(
      available: true,
      currentVersion: _currentMobileVersion,
      source: 'OpenList',
      releaseUrl: _openListMobileUrl,
      apkUrl: _openListMobileUrl,
      body: '移动端安装包已迁移到 OpenList 下载目录。',
    );
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
