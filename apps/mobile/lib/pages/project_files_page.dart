import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';

class ProjectFilesPage extends StatefulWidget {
  const ProjectFilesPage({super.key, required this.project});

  final WorkspaceProject project;

  @override
  State<ProjectFilesPage> createState() => _ProjectFilesPageState();
}

class _ProjectFilesPageState extends State<ProjectFilesPage> {
  final List<String> _directoryStack = [];
  List<WorkspaceFileEntry> _entries = const [];
  bool _loading = true;
  String? _error;
  int _requestVersion = 0;

  String? get _currentDirectory =>
      _directoryStack.isEmpty ? null : _directoryStack.last;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_requestVersion == 0) _load();
  }

  Future<void> _load() async {
    final requestVersion = ++_requestVersion;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final entries = await WorkspaceScope.of(context).listProjectFiles(
        widget.project,
        directoryPath: _currentDirectory,
      );
      if (!mounted || requestVersion != _requestVersion) return;
      setState(() => _entries = entries);
    } catch (error) {
      if (!mounted || requestVersion != _requestVersion) return;
      setState(() => _error = _errorText(error));
    } finally {
      if (mounted && requestVersion == _requestVersion) {
        setState(() => _loading = false);
      }
    }
  }

  void _openDirectory(WorkspaceFileEntry entry) {
    _directoryStack.add(entry.path);
    _load();
  }

  void _goUp() {
    if (_directoryStack.isEmpty) {
      Navigator.of(context).maybePop();
      return;
    }
    _directoryStack.removeLast();
    _load();
  }

  void _openFile(WorkspaceFileEntry entry) {
    final workspace = WorkspaceScope.of(context);
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => WorkspaceScope(
          controller: workspace,
          child: ProjectFilePreviewPage(
            project: widget.project,
            file: entry,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: _directoryStack.isEmpty,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _goUp();
      },
      child: Scaffold(
        backgroundColor: AppColors.background,
        appBar: AppBar(
          leading: IconButton(
            icon: Icon(
              _directoryStack.isEmpty
                  ? Icons.arrow_back
                  : Icons.arrow_upward,
            ),
            tooltip: _directoryStack.isEmpty ? '返回' : '上一级',
            onPressed: _goUp,
          ),
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                widget.project.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              Text(
                _relativeDirectoryLabel(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: AppColors.muted,
                  fontSize: 11,
                  fontWeight: FontWeight.w400,
                ),
              ),
            ],
          ),
          actions: [
            IconButton(
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh),
              tooltip: '刷新',
            ),
          ],
        ),
        body: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading && _entries.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _entries.isEmpty) {
      return _FilesError(message: _error!, onRetry: _load);
    }
    if (_entries.isEmpty) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.folder_off_outlined, size: 36, color: AppColors.muted),
            SizedBox(height: AppSpacing.sm),
            Text('当前目录为空', style: TextStyle(color: AppColors.muted)),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        itemCount: _entries.length + (_error == null ? 0 : 1),
        separatorBuilder: (_, __) => const Divider(
          height: 1,
          indent: 56,
          color: AppColors.divider,
        ),
        itemBuilder: (context, index) {
          if (_error != null && index == 0) {
            return MaterialBanner(
              content: Text(_error!),
              actions: [
                TextButton(onPressed: _load, child: const Text('重试')),
              ],
            );
          }
          final entryIndex = index - (_error == null ? 0 : 1);
          final entry = _entries[entryIndex];
          return ListTile(
            minLeadingWidth: 28,
            leading: Icon(
              entry.isDirectory
                  ? Icons.folder_outlined
                  : _fileIcon(entry.name),
              color: entry.isDirectory ? AppColors.primary : AppColors.secondary,
            ),
            title: Text(
              entry.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(
              entry.isDirectory ? '文件夹' : _fileSize(entry.size),
              style: const TextStyle(color: AppColors.muted, fontSize: 11),
            ),
            trailing: const Icon(
              Icons.chevron_right,
              size: 18,
              color: AppColors.muted,
            ),
            onTap: () =>
                entry.isDirectory ? _openDirectory(entry) : _openFile(entry),
          );
        },
      ),
    );
  }

  String _relativeDirectoryLabel() {
    final current = _currentDirectory;
    if (current == null) return '/';
    final root = widget.project.path.replaceAll('\\', '/');
    final normalized = current.replaceAll('\\', '/');
    if (!normalized.startsWith(root)) return normalized;
    final relative = normalized
        .substring(root.length)
        .replaceFirst(RegExp(r'^/+'), '');
    return relative.isEmpty ? '/' : '/$relative';
  }
}

class ProjectFilePreviewPage extends StatefulWidget {
  const ProjectFilePreviewPage({
    super.key,
    required this.project,
    required this.file,
  });

  final WorkspaceProject project;
  final WorkspaceFileEntry file;

  @override
  State<ProjectFilePreviewPage> createState() =>
      _ProjectFilePreviewPageState();
}

class _ProjectFilePreviewPageState extends State<ProjectFilePreviewPage> {
  ProjectFilePreview? _preview;
  String? _error;
  bool _requested = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_requested) {
      _requested = true;
      _load();
    }
  }

  Future<void> _load() async {
    setState(() {
      _preview = null;
      _error = null;
    });
    try {
      final preview = await WorkspaceScope.of(context)
          .readProjectFilePreview(widget.project, widget.file.path);
      if (mounted) setState(() => _preview = preview);
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Text(
          widget.file.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        actions: [
          IconButton(
            onPressed: _preview == null && _error == null ? null : _load,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: _preview == null
          ? _error == null
              ? const Center(child: CircularProgressIndicator())
              : _FilesError(message: _error!, onRetry: _load)
          : _PreviewBody(preview: _preview!),
    );
  }
}

class _PreviewBody extends StatelessWidget {
  const _PreviewBody({required this.preview});

  final ProjectFilePreview preview;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.md,
            vertical: AppSpacing.sm,
          ),
          color: AppColors.surface,
          child: Text(
            '${preview.language ?? preview.mimeType ?? 'FILE'} · ${_fileSize(preview.size)}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: AppColors.muted, fontSize: 11),
          ),
        ),
        const Divider(height: 1, color: AppColors.border),
        Expanded(child: _previewContent()),
      ],
    );
  }

  Widget _previewContent() {
    if (preview.previewKind == 'text') {
      return Scrollbar(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SelectableText(
              preview.content ?? '',
              style: const TextStyle(
                color: AppColors.ink,
                fontSize: 12,
                height: 1.55,
                fontFamily: 'monospace',
                letterSpacing: 0,
              ),
            ),
          ),
        ),
      );
    }
    if (preview.previewKind == 'image' && preview.mimeType != 'image/svg+xml') {
      final bytes = _imageBytes(preview.dataUrl);
      if (bytes != null) {
        return InteractiveViewer(
          minScale: 0.5,
          maxScale: 5,
          child: Center(
            child: Image.memory(bytes, fit: BoxFit.contain),
          ),
        );
      }
    }
    final message = preview.previewKind == 'tooLarge'
        ? '文件过大，暂不支持移动端直接预览。'
        : preview.mimeType == 'image/svg+xml'
            ? 'SVG 图片暂不支持移动端直接预览。'
            : '这是二进制文件，暂不支持直接预览。';
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.description_outlined,
              size: 40,
              color: AppColors.muted,
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColors.secondary),
            ),
          ],
        ),
      ),
    );
  }
}

class _FilesError extends StatelessWidget {
  const _FilesError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 40, color: AppColors.danger),
            const SizedBox(height: AppSpacing.md),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColors.secondary),
            ),
            const SizedBox(height: AppSpacing.md),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }
}

Uint8List? _imageBytes(String? dataUrl) {
  if (dataUrl == null) return null;
  final separator = dataUrl.indexOf(',');
  if (separator < 0) return null;
  try {
    return base64Decode(dataUrl.substring(separator + 1));
  } catch (_) {
    return null;
  }
}

IconData _fileIcon(String name) {
  final lower = name.toLowerCase();
  if (lower.endsWith('.png') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.gif') ||
      lower.endsWith('.webp')) {
    return Icons.image_outlined;
  }
  if (lower.endsWith('.md') || lower.endsWith('.txt')) {
    return Icons.article_outlined;
  }
  if (lower.endsWith('.json') ||
      lower.endsWith('.yaml') ||
      lower.endsWith('.yml')) {
    return Icons.data_object;
  }
  return Icons.description_outlined;
}

String _fileSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

String _errorText(Object error) {
  final text = error.toString();
  return text
      .replaceFirst('Bad state: ', '')
      .replaceFirst('TimeoutException: ', '');
}
