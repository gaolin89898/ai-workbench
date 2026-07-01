import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import 'app_theme.dart';

class ChatSegmentView extends StatelessWidget {
  const ChatSegmentView(
      {super.key,
      required this.segment,
      this.compact = false,
      this.onApproval});

  final ChatSegment segment;
  final bool compact;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
    return switch (segment.type) {
      'status' => _StatusSegment(segment: segment),
      'tool' => _ToolSegment(segment: segment, compact: compact),
      'thought' => _ThoughtSegment(segment: segment),
      'error' => _ErrorSegment(segment: segment),
      'approval' => _ApprovalSegment(segment: segment, onApproval: onApproval),
      _ => _TextSegment(text: segment.text ?? segment.message ?? ''),
    };
  }
}

class ChatMessageContent extends StatelessWidget {
  const ChatMessageContent({super.key, required this.message, this.onApproval});

  final ChatMessage message;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
    final visibleSegments = message.segments.where((s) {
      if (s.stepId == 'runtime-status' || s.stepId == 'initial-thinking')
        return false;
      if (s.type == 'status' && s.stepId == 'final-summary') return false;
      return true;
    }).toList();

    final groups = <_SegmentGroup>[];
    final processRun = <ChatSegment>[];
    for (final segment in visibleSegments) {
      if (_isProcessSegment(segment)) {
        processRun.add(segment);
        continue;
      }
      if (processRun.isNotEmpty) {
        groups.add(_SegmentGroup.process(processRun));
        processRun.clear();
      }
      groups.add(_SegmentGroup.segment(segment));
    }
    if (processRun.isNotEmpty) groups.add(_SegmentGroup.process(processRun));

    final hasInlineTextSegment = visibleSegments
        .any((s) => s.type == 'text' && (s.text ?? '').trim().isNotEmpty);
    final finalText = hasInlineTextSegment ? '' : _finalContentText(message);
    final hasVisibleContent = visibleSegments.any((segment) {
      if (_isProcessSegment(segment)) return true;
      return segment.type != 'text' || (segment.text ?? '').trim().isNotEmpty;
    });
    final isThinking =
        message.pending && finalText.isEmpty && !hasVisibleContent;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final group in groups) ...[
          if (group.isProcess)
            _ProcessGroupCard(
                segments: group.segments,
                pending: message.pending,
                onApproval: onApproval)
          else
            ChatSegmentView(
                segment: group.singleSegment, onApproval: onApproval),
          const SizedBox(height: 8),
        ],
        if (isThinking)
          const _TypingText()
        else if (finalText.trim().isNotEmpty)
          SelectableText(
            finalText,
            style: const TextStyle(
                color: AppColors.ink, fontSize: 13, height: 1.62),
          ),
      ],
    );
  }
}

class _ProcessGroupCard extends StatelessWidget {
  const _ProcessGroupCard(
      {required this.segments, required this.pending, this.onApproval});

  final List<ChatSegment> segments;
  final bool pending;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
    if (segments.length == 1) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: ChatSegmentView(
            segment: segments.first, compact: true, onApproval: onApproval),
      );
    }
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: AppColors.surfaceMuted,
        borderRadius: BorderRadius.circular(AppRadius.lg),
        border: Border.all(color: AppColors.border),
      ),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          initiallyExpanded: false,
          tilePadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 0),
          childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
          dense: true,
          visualDensity: VisualDensity.compact,
          iconColor: AppColors.muted,
          collapsedIconColor: AppColors.muted,
          title: Row(
            children: [
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(
                  color: pending ? AppColors.warning : AppColors.successDeep,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '已运行 ${segments.length} 步',
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
            for (final segment in segments)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: ChatSegmentView(
                    segment: segment, compact: true, onApproval: onApproval),
              ),
          ],
        ),
      ),
    );
  }
}

class _SegmentGroup {
  final bool isProcess;
  final List<ChatSegment> segments;

  const _SegmentGroup._({required this.isProcess, required this.segments});

  factory _SegmentGroup.segment(ChatSegment segment) =>
      _SegmentGroup._(isProcess: false, segments: [segment]);
  factory _SegmentGroup.process(List<ChatSegment> segments) =>
      _SegmentGroup._(isProcess: true, segments: segments);

  ChatSegment get singleSegment => segments.first;
}

class ChatProcessPanel extends StatelessWidget {
  const ChatProcessPanel(
      {super.key,
      required this.segments,
      this.pending = false,
      this.onApproval});

  final List<ChatSegment> segments;
  final bool pending;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
    final processSegments = segments
        .where(_isProcessSegment)
        .where(_shouldShowProcessSegment)
        .toList();
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
          initiallyExpanded: false,
          tilePadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 0),
          childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
          dense: true,
          visualDensity: VisualDensity.compact,
          iconColor: AppColors.muted,
          collapsedIconColor: AppColors.muted,
          title: Row(
            children: [
              Icon(pending ? Icons.sync : Icons.check_circle_outline,
                  size: 14,
                  color: pending ? AppColors.warning : AppColors.successDeep),
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
                child: ChatSegmentView(
                    segment: segment, compact: true, onApproval: onApproval),
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
                style: const TextStyle(
                    color: AppColors.secondary,
                    fontSize: 12,
                    height: 1.45,
                    fontWeight: FontWeight.w600),
              ),
              if ((segment.detail ?? '').isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(segment.detail!,
                    style: const TextStyle(
                        color: AppColors.muted, fontSize: 11, height: 1.4)),
              ],
            ],
          ),
        ),
        if (segment.additions != null || segment.deletions != null)
          _ChangeMeta(segment: segment),
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
    final visibleInput = _toolVisibleInput(segment);
    final visibleOutput = _toolVisibleOutput(segment);
    final diff = _toolDiffText(segment);
    final hasDetails = visibleInput.isNotEmpty ||
        visibleOutput.isNotEmpty ||
        diff.isNotEmpty ||
        (segment.summary ?? '').isNotEmpty;
    final line = Container(
      padding: EdgeInsets.symmetric(
          horizontal: compact ? 9 : 10, vertical: compact ? 8 : 10),
      decoration: BoxDecoration(
        color: failed ? AppColors.dangerSoft : AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(
            color: failed ? const Color(0xffffcdd2) : AppColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            running
                ? Icons.sync
                : failed
                    ? Icons.error_outline
                    : Icons.terminal,
            size: 15,
            color: running
                ? AppColors.warningDeep
                : failed
                    ? AppColors.danger
                    : AppColors.secondary,
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
                  Wrap(
                    spacing: 4,
                    runSpacing: 2,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      for (final item in meta)
                        Text(
                          item.text,
                          style: TextStyle(
                            color: _toolMetaColor(item.kind),
                            fontSize: 11,
                            height: 1.35,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                    ],
                  ),
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
        trailing:
            const Icon(Icons.expand_more, size: 18, color: AppColors.muted),
        children: [
          if ((segment.summary ?? '').isNotEmpty)
            _DetailBlock(segment.summary!),
          if (visibleInput.isNotEmpty) _CodeBlock(visibleInput),
          if (visibleOutput.isNotEmpty) _CodeBlock(visibleOutput),
          if (diff.isNotEmpty) _DiffBlock(diff),
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
      decoration: const BoxDecoration(
          border: Border(
              left: BorderSide(color: AppColors.borderActive, width: 2))),
      child: Text(
        segment.text ?? segment.title ?? '思考中',
        style: const TextStyle(
            color: AppColors.secondary, fontSize: 12, height: 1.5),
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
        style: const TextStyle(
            color: AppColors.danger,
            fontSize: 12,
            fontWeight: FontWeight.w700,
            height: 1.45),
      ),
    );
  }
}

class _ApprovalSegment extends StatelessWidget {
  const _ApprovalSegment({required this.segment, this.onApproval});

  final ChatSegment segment;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
    final status = segment.status ?? 'pending';
    final pending = status == 'pending';
    final approved = status == 'approved';
    final color = approved
        ? AppColors.successDeep
        : pending
            ? AppColors.warningDeep
            : AppColors.danger;
    final background = approved
        ? const Color(0xffecfdf3)
        : pending
            ? const Color(0xfffff7ed)
            : AppColors.dangerSoft;
    final meta = _approvalMeta(segment);
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: color.withValues(alpha: 0.24)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.verified_user_outlined, size: 16, color: color),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      segment.title ?? '需要审批',
                      style: TextStyle(
                        color: color,
                        fontSize: 12,
                        height: 1.4,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    if (meta.isNotEmpty)
                      Text(
                        meta,
                        style: const TextStyle(
                          color: AppColors.muted,
                          fontSize: 11,
                          height: 1.35,
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
          if ((segment.reason ?? '').isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              segment.reason!,
              style: const TextStyle(
                  color: AppColors.secondary, fontSize: 12, height: 1.45),
            ),
          ],
          if ((segment.command ?? '').isNotEmpty) ...[
            const SizedBox(height: 8),
            _CodeBlock(segment.command!),
          ],
          if (segment.fileChanges.isNotEmpty) ...[
            const SizedBox(height: 8),
            for (final file in segment.fileChanges.take(5))
              Text(
                file,
                style: const TextStyle(
                    color: AppColors.secondary, fontSize: 11, height: 1.45),
              ),
          ],
          if ((segment.detail ?? '').isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              segment.detail!,
              style: const TextStyle(
                  color: AppColors.secondary, fontSize: 12, height: 1.45),
            ),
          ],
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              OutlinedButton(
                onPressed: pending && onApproval != null
                    ? () => onApproval!(segment, 'denied')
                    : null,
                child: const Text('拒绝'),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: pending && onApproval != null
                    ? () => onApproval!(segment, 'approved')
                    : null,
                child: const Text('同意本次'),
              ),
            ],
          ),
        ],
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
      child: Text(text,
          style: const TextStyle(
              color: AppColors.secondary, fontSize: 12, height: 1.45)),
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
        style: const TextStyle(
            color: Color(0xffe2e8f0),
            fontFamily: 'monospace',
            fontSize: 11,
            height: 1.45),
      ),
    );
  }
}

class _DiffBlock extends StatelessWidget {
  const _DiffBlock(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final lines = text
        .replaceAll('\r\n', '\n')
        .split('\n')
        .where((line) => !_isPatchWrapperLine(line))
        .toList();
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      constraints: const BoxConstraints(maxHeight: 260),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: AppColors.border),
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final line in lines)
              Container(
                color: _diffLineBackground(line),
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: SelectableText(
                  line.isEmpty ? ' ' : line,
                  style: TextStyle(
                    color: _diffLineColor(line),
                    fontFamily: 'monospace',
                    fontSize: 11,
                    height: 1.45,
                  ),
                ),
              ),
          ],
        ),
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
          Text('+${segment.additions}',
              style: const TextStyle(
                  color: AppColors.successDeep,
                  fontSize: 11,
                  fontWeight: FontWeight.w700)),
        if (segment.deletions != null) ...[
          const SizedBox(width: 4),
          Text('-${segment.deletions}',
              style: const TextStyle(
                  color: AppColors.danger,
                  fontSize: 11,
                  fontWeight: FontWeight.w700)),
        ],
      ],
    );
  }
}

class ChatBubble extends StatelessWidget {
  const ChatBubble({super.key, required this.message, this.onApproval});

  final ChatMessage message;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
    final isUser = message.role == ChatRole.user;
    final isError = message.role == ChatRole.error;
    final isSystem = message.role == ChatRole.system;
    if (isSystem) {
      return Center(
        child: Container(
          margin: const EdgeInsets.only(bottom: 12),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(
              color: AppColors.surfaceMuted,
              borderRadius: BorderRadius.circular(999)),
          child: Text(message.text ?? '',
              style: const TextStyle(color: AppColors.muted, fontSize: 12)),
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
          border: isUser
              ? null
              : Border.all(
                  color: isError ? const Color(0xffffcdd2) : AppColors.border),
        ),
        child: isUser
            ? SelectableText(message.text ?? '',
                style: const TextStyle(color: AppColors.inverse, height: 1.5))
            : ChatMessageContent(message: message, onApproval: onApproval),
      ),
    );
  }
}

class _TypingText extends StatelessWidget {
  const _TypingText();

  @override
  Widget build(BuildContext context) {
    return const Text('正在思考...',
        style: TextStyle(color: AppColors.muted, fontSize: 12));
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
  return segment.type == 'tool' ||
      segment.type == 'status' ||
      segment.type == 'thought' ||
      segment.type == 'error' ||
      segment.type == 'approval';
}

bool _shouldShowProcessSegment(ChatSegment segment) {
  return segment.stepId != 'initial-thinking';
}

String _summaryLabel(List<ChatSegment> segments, bool pending) {
  final finalSummary = segments
      .where((segment) =>
          segment.type == 'status' && segment.stepId == 'final-summary')
      .firstOrNull;
  if (finalSummary?.label != null) return finalSummary!.label!;
  if (pending) return '正在处理';
  return '执行过程';
}

String _toolTitle(ChatSegment segment) {
  final patchFiles = _patchFileList(_toolDiffText(segment));
  final command = patchFiles.isNotEmpty
      ? _shortFileList(patchFiles)
      : _shortenCommand(segment.command);
  final verb = segment.status == 'running' ? '正在' : '已';
  final toolName = segment.toolName ?? '工具调用';
  if (_isStdinContinuationSegment(segment)) {
    if (segment.status == 'error') return '读取命令输出失败';
    return segment.status == 'running' ? '正在读取命令输出' : '已读取命令输出';
  }
  if (toolName.contains('修改') || toolName.contains('文件')) {
    if (segment.status == 'error')
      return command.isNotEmpty ? '修改 $command 文件失败' : '修改文件失败';
    return command.isNotEmpty
        ? '${segment.status == 'running' ? '正在修改' : '已修改'} $command 文件'
        : '${segment.status == 'running' ? '正在处理' : '已处理'}文件修改';
  }
  if (toolName.contains('命令') ||
      toolName.contains('command') ||
      (segment.command ?? '').isNotEmpty) {
    if (segment.status == 'error')
      return command.isNotEmpty ? '运行失败 $command' : '运行命令失败';
    return command.isNotEmpty ? '$verb运行 $command' : '$verb运行命令';
  }
  if (segment.status == 'error') return segment.summary ?? '处理失败 $toolName';
  return segment.summary ?? '$verb处理 $toolName';
}

typedef _ToolMetaItem = ({String kind, String text});

List<_ToolMetaItem> _toolMeta(ChatSegment segment) {
  final parts = <_ToolMetaItem>[];
  final stats = _diffStats(_toolDiffText(segment));
  final additions = segment.additions ?? stats.additions;
  final deletions = segment.deletions ?? stats.deletions;
  if (additions != null) parts.add((kind: 'add', text: '+$additions'));
  if (deletions != null) parts.add((kind: 'delete', text: '-$deletions'));
  if (segment.status == 'error') parts.add((kind: 'error', text: '失败'));
  if (segment.durationMs != null)
    parts.add((kind: 'duration', text: _formatDuration(segment.durationMs!)));
  return parts;
}

Color _toolMetaColor(String kind) {
  if (kind == 'add') return AppColors.successDeep;
  if (kind == 'delete' || kind == 'error') return AppColors.danger;
  return AppColors.muted;
}

String _toolDiffText(ChatSegment segment) {
  final diff = (segment.diff ?? '').trim();
  if (diff.isNotEmpty) return segment.diff ?? '';
  final input = (segment.input ?? '').trim();
  return input.startsWith('*** Begin Patch') ? segment.input ?? '' : '';
}

String _toolVisibleInput(ChatSegment segment) {
  return _toolDiffText(segment).isNotEmpty ? '' : segment.input ?? '';
}

String _toolVisibleOutput(ChatSegment segment) {
  return _cleanToolOutput(segment.output ?? '');
}

String _cleanToolOutput(String output) {
  final lines = output.replaceAll('\r\n', '\n').split('\n');
  final outputIndex = lines.indexWhere((line) => line.trim() == 'Output:');
  final visibleLines =
      (outputIndex >= 0 ? lines.skip(outputIndex + 1) : lines).where((line) {
    final trimmed = line.trim();
    if (RegExp(
            r'^(Chunk ID|Wall time|Process exited with code|Original token count):')
        .hasMatch(trimmed)) {
      return false;
    }
    if (trimmed == 'Output:') return false;
    if (trimmed == 'Failed to create stream fd: Operation not permitted') {
      return false;
    }
    return true;
  }).toList();
  return visibleLines.join('\n').trim();
}

bool _isStdinContinuationSegment(ChatSegment segment) {
  final input = segment.input ?? '';
  return segment.toolName == '文件修改' &&
      input.contains('"session_id"') &&
      input.contains('"yield_time_ms"') &&
      input.contains('"max_output_tokens"');
}

List<String> _patchFileList(String diff) {
  final files = <String>[];
  final seen = <String>{};
  for (final line in diff.replaceAll('\r\n', '\n').split('\n')) {
    final match =
        RegExp(r'^\*\*\* (?:Add|Update|Delete) File: (.+)$').firstMatch(line);
    final file = match?.group(1)?.trim();
    if (file == null || file.isEmpty || seen.contains(file)) continue;
    seen.add(file);
    files.add(file);
  }
  return files;
}

String _shortFileList(List<String> files) {
  if (files.length <= 2) return files.join(', ');
  return '${files.take(2).join(', ')} 等 ${files.length} 个';
}

({int? additions, int? deletions}) _diffStats(String diff) {
  if (diff.trim().isEmpty) return (additions: null, deletions: null);
  var additions = 0;
  var deletions = 0;
  for (final line in diff.replaceAll('\r\n', '\n').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return (additions: additions, deletions: deletions);
}

Color _diffLineBackground(String line) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return const Color(0xffecfdf3);
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return const Color(0xfffef2f2);
  }
  if (line.startsWith('***') || line.startsWith('@@')) {
    return AppColors.surfaceMuted;
  }
  return AppColors.surface;
}

Color _diffLineColor(String line) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return AppColors.successDeep;
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return AppColors.danger;
  }
  if (line.startsWith('***') || line.startsWith('@@')) {
    return AppColors.secondary;
  }
  return AppColors.ink;
}

bool _isPatchWrapperLine(String line) {
  return line.startsWith('*** Begin Patch') ||
      line.startsWith('*** End Patch') ||
      RegExp(r'^\*\*\* (?:Add|Update|Delete) File: ').hasMatch(line) ||
      line.startsWith('@@');
}

String _approvalMeta(ChatSegment segment) {
  final parts = <String>[];
  if ((segment.cwd ?? '').isNotEmpty) parts.add('目录 ${segment.cwd}');
  if ((segment.grantRoot ?? '').isNotEmpty)
    parts.add('授权 ${segment.grantRoot}');
  if (segment.fileChanges.isNotEmpty)
    parts.add('${segment.fileChanges.length} 个文件');
  return parts.join(' · ');
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
