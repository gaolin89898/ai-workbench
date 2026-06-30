import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import 'app_theme.dart';

class ChatSegmentView extends StatelessWidget {
  const ChatSegmentView({super.key, required this.segment, this.compact = false});

  final ChatSegment segment;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return switch (segment.type) {
      'status' => _StatusSegment(segment: segment),
      'tool' => _ToolSegment(segment: segment, compact: compact),
      'thought' => _ThoughtSegment(segment: segment),
      'error' => _ErrorSegment(segment: segment),
      _ => _TextSegment(text: segment.text ?? segment.message ?? ''),
    };
  }
}

class ChatProcessPanel extends StatelessWidget {
  const ChatProcessPanel({super.key, required this.segments, this.pending = false});

  final List<ChatSegment> segments;
  final bool pending;

  @override
  Widget build(BuildContext context) {
    final processSegments = segments.where(_isProcessSegment).where(_shouldShowProcessSegment).toList();
    if (processSegments.isEmpty) return const SizedBox.shrink();
    final summary = _summaryLabel(processSegments, pending);
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: AppColors.surfaceMuted,
        borderRadius: BorderRadius.circular(AppRadius.lg),
        border: Border.all(color: AppColors.border),
      ),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          initiallyExpanded: true,
          tilePadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 0),
          childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
          dense: true,
          visualDensity: VisualDensity.compact,
          iconColor: AppColors.muted,
          collapsedIconColor: AppColors.muted,
          title: Row(
            children: [
              Icon(pending ? Icons.sync : Icons.check_circle_outline, size: 14, color: pending ? AppColors.warning : AppColors.successDeep),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  summary,
                  style: const TextStyle(
                    color: AppColors.secondary,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          children: [
            for (final segment in processSegments)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: ChatSegmentView(segment: segment, compact: true),
              ),
          ],
        ),
      ),
    );
  }
}

class ChatFinalContent extends StatelessWidget {
  const ChatFinalContent({super.key, required this.text, this.pending = false});

  final String text;
  final bool pending;

  @override
  Widget build(BuildContext context) {
    if (text.trim().isEmpty && !pending) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
      child: text.trim().isEmpty
          ? const _TypingText()
          : SelectableText(
              text,
              style: const TextStyle(
                color: AppColors.ink,
                fontSize: 13,
                height: 1.62,
              ),
            ),
    );
  }
}

class _TextSegment extends StatelessWidget {
  const _TextSegment({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    if (text.trim().isEmpty) return const SizedBox.shrink();
    return SelectableText(
      text,
      style: const TextStyle(color: AppColors.ink, fontSize: 13, height: 1.6),
    );
  }
}

class _StatusSegment extends StatelessWidget {
  const _StatusSegment({required this.segment});

  final ChatSegment segment;

  @override
  Widget build(BuildContext context) {
    final icon = switch (segment.icon) {
      'check' => Icons.check_circle_outline,
      'warn' => Icons.warning_amber_rounded,
      'search' => Icons.search,
      'edit' => Icons.edit_outlined,
      'read' => Icons.article_outlined,
      _ => Icons.circle_outlined,
    };
    final color = segment.icon == 'warn'
        ? AppColors.warningDeep
        : segment.icon == 'check'
            ? AppColors.successDeep
            : AppColors.muted;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: color, size: 15),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                segment.label ?? segment.text ?? 'AI 正在执行',
                style: const TextStyle(color: AppColors.secondary, fontSize: 12, height: 1.45, fontWeight: FontWeight.w600),
              ),
              if ((segment.detail ?? '').isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(segment.detail!, style: const TextStyle(color: AppColors.muted, fontSize: 11, height: 1.4)),
              ],
            ],
          ),
        ),
        if (segment.additions != null || segment.deletions != null) _ChangeMeta(segment: segment),
      ],
    );
  }
}

class _ToolSegment extends StatelessWidget {
  const _ToolSegment({required this.segment, required this.compact});

  final ChatSegment segment;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final failed = segment.status == 'error';
    final running = segment.status == 'running';
    final title = _toolTitle(segment);
    final meta = _toolMeta(segment);
    final hasDetails = (segment.input ?? '').isNotEmpty ||
        (segment.output ?? '').isNotEmpty ||
        (segment.diff ?? '').isNotEmpty ||
        (segment.summary ?? '').isNotEmpty;
    final line = Container(
      padding: EdgeInsets.symmetric(horizontal: compact ? 9 : 10, vertical: compact ? 8 : 10),
      decoration: BoxDecoration(
        color: failed ? AppColors.dangerSoft : AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: failed ? const Color(0xffffcdd2) : AppColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            running ? Icons.sync : failed ? Icons.error_outline : Icons.terminal,
            size: 15,
            color: running ? AppColors.warningDeep : failed ? AppColors.danger : AppColors.secondary,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: failed ? AppColors.danger : AppColors.ink,
                    fontSize: 12,
                    height: 1.35,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (meta.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(meta, style: const TextStyle(color: AppColors.muted, fontSize: 11, height: 1.35)),
                ],
              ],
            ),
          ),
        ],
      ),
    );
    if (!hasDetails) return line;
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(top: 8),
        initiallyExpanded: false,
        title: line,
        trailing: const Icon(Icons.expand_more, size: 18, color: AppColors.muted),
        children: [
          if ((segment.summary ?? '').isNotEmpty) _DetailBlock(segment.summary!),
          if ((segment.input ?? '').isNotEmpty) _CodeBlock(segment.input!),
          if ((segment.output ?? '').isNotEmpty) _CodeBlock(segment.output!),
          if ((segment.diff ?? '').isNotEmpty) _CodeBlock(segment.diff!),
        ],
      ),
    );
  }
}

class _ThoughtSegment extends StatelessWidget {
  const _ThoughtSegment({required this.segment});

  final ChatSegment segment;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.only(left: 10, top: 2, bottom: 2),
      decoration: const BoxDecoration(border: Border(left: BorderSide(color: AppColors.borderActive, width: 2))),
      child: Text(
        segment.text ?? segment.title ?? '思考中',
        style: const TextStyle(color: AppColors.secondary, fontSize: 12, height: 1.5),
      ),
    );
  }
}

class _ErrorSegment extends StatelessWidget {
  const _ErrorSegment({required this.segment});

  final ChatSegment segment;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppColors.dangerSoft,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: const Color(0xffffcdd2)),
      ),
      child: Text(
        segment.message ?? segment.text ?? '执行失败',
        style: const TextStyle(color: AppColors.danger, fontSize: 12, fontWeight: FontWeight.w700, height: 1.45),
      ),
    );
  }
}

class _DetailBlock extends StatelessWidget {
  const _DetailBlock(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      child: Text(text, style: const TextStyle(color: AppColors.secondary, fontSize: 12, height: 1.45)),
    );
  }
}

class _CodeBlock extends StatelessWidget {
  const _CodeBlock(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xff0f172a),
        borderRadius: BorderRadius.circular(AppRadius.md),
      ),
      child: SelectableText(
        text,
        style: const TextStyle(color: Color(0xffe2e8f0), fontFamily: 'monospace', fontSize: 11, height: 1.45),
      ),
    );
  }
}

class _ChangeMeta extends StatelessWidget {
  const _ChangeMeta({required this.segment});

  final ChatSegment segment;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (segment.additions != null)
          Text('+${segment.additions}', style: const TextStyle(color: AppColors.successDeep, fontSize: 11, fontWeight: FontWeight.w700)),
        if (segment.deletions != null) ...[
          const SizedBox(width: 4),
          Text('-${segment.deletions}', style: const TextStyle(color: AppColors.danger, fontSize: 11, fontWeight: FontWeight.w700)),
        ],
      ],
    );
  }
}

class ChatBubble extends StatelessWidget {
  const ChatBubble({super.key, required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    final isUser = message.role == ChatRole.user;
    final isError = message.role == ChatRole.error;
    final isSystem = message.role == ChatRole.system;
    final finalText = _finalContentText(message);
    if (isSystem) {
      return Center(
        child: Container(
          margin: const EdgeInsets.only(bottom: 12),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(color: AppColors.surfaceMuted, borderRadius: BorderRadius.circular(999)),
          child: Text(message.text ?? '', style: const TextStyle(color: AppColors.muted, fontSize: 12)),
        ),
      );
    }
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 340),
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: isUser
              ? AppColors.primary
              : isError
                  ? AppColors.dangerSoft
                  : AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: isUser ? null : Border.all(color: isError ? const Color(0xffffcdd2) : AppColors.border),
        ),
        child: isUser
            ? SelectableText(message.text ?? '', style: const TextStyle(color: AppColors.inverse, height: 1.5))
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ChatProcessPanel(segments: message.segments, pending: message.pending),
                  ChatFinalContent(text: finalText, pending: message.pending && finalText.trim().isEmpty),
                ],
              ),
      ),
    );
  }
}

class _TypingText extends StatelessWidget {
  const _TypingText();

  @override
  Widget build(BuildContext context) {
    return const Text('处理中...', style: TextStyle(color: AppColors.muted, fontSize: 12));
  }
}

String _finalContentText(ChatMessage message) {
  final text = (message.text ?? '').trim();
  if (text.isNotEmpty) return text;
  final textSegments = message.segments
      .where((segment) => segment.type == 'text')
      .map((segment) => segment.text?.trim() ?? '')
      .where((value) => value.isNotEmpty)
      .toList();
  return textSegments.join('\n\n');
}

bool _isProcessSegment(ChatSegment segment) {
  return segment.type == 'tool' || segment.type == 'status' || segment.type == 'thought' || segment.type == 'error';
}

bool _shouldShowProcessSegment(ChatSegment segment) {
  return segment.stepId != 'initial-thinking';
}

String _summaryLabel(List<ChatSegment> segments, bool pending) {
  final finalSummary = segments.where((segment) => segment.type == 'status' && segment.stepId == 'final-summary').firstOrNull;
  if (finalSummary?.label != null) return finalSummary!.label!;
  if (pending) return '正在处理';
  return '执行过程';
}

String _toolTitle(ChatSegment segment) {
  final command = _shortenCommand(segment.command);
  final verb = segment.status == 'running' ? '正在' : '已';
  final toolName = segment.toolName ?? '工具调用';
  if (toolName.contains('修改') || toolName.contains('文件')) {
    if (segment.status == 'error') return command.isNotEmpty ? '修改 $command 文件失败' : '修改文件失败';
    return command.isNotEmpty ? '${segment.status == 'running' ? '正在修改' : '已修改'} $command 文件' : '${segment.status == 'running' ? '正在修改' : '已修改'}文件';
  }
  if (toolName.contains('命令') || toolName.contains('command') || (segment.command ?? '').isNotEmpty) {
    if (segment.status == 'error') return command.isNotEmpty ? '运行失败 $command' : '运行命令失败';
    return command.isNotEmpty ? '$verb运行 $command' : '$verb运行命令';
  }
  if (segment.status == 'error') return segment.summary ?? '处理失败 $toolName';
  return segment.summary ?? '$verb处理 $toolName';
}

String _toolMeta(ChatSegment segment) {
  final parts = <String>[];
  if (segment.additions != null) parts.add('+${segment.additions}');
  if (segment.deletions != null) parts.add('-${segment.deletions}');
  if (segment.status == 'error') parts.add('失败');
  if (segment.durationMs != null) parts.add(_formatDuration(segment.durationMs!));
  return parts.join(' ');
}

String _formatDuration(int durationMs) {
  if (durationMs < 1000) return '${durationMs}ms';
  final seconds = durationMs / 1000;
  return '${seconds.toStringAsFixed(seconds < 10 ? 1 : 0)}s';
}

String _shortenCommand(String? command) {
  final cleaned = (command ?? '')
      .replaceFirst(RegExp(r'^/usr/bin/(bash|sh)\s+-lc\s+'), '')
      .replaceFirst(RegExp(r'^bash\s+-lc\s+'), '')
      .trim();
  final unquoted = cleaned.replaceFirst(RegExp(r'''^['"](.+)['"]$'''), r'$1');
  return unquoted.length > 64 ? '${unquoted.substring(0, 61)}...' : unquoted;
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    for (final item in this) {
      return item;
    }
    return null;
  }
}
