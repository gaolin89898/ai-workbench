import 'dart:async';

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

class ChatMessageContent extends StatefulWidget {
  const ChatMessageContent({super.key, required this.message, this.onApproval});

  final ChatMessage message;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  State<ChatMessageContent> createState() => _ChatMessageContentState();
}

class _ChatMessageContentState extends State<ChatMessageContent> {
  int _nowTick = DateTime.now().millisecondsSinceEpoch;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _maybeStartTimer();
  }

  @override
  void didUpdateWidget(covariant ChatMessageContent oldWidget) {
    super.didUpdateWidget(oldWidget);
    _maybeStartTimer();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }

  void _maybeStartTimer() {
    if (widget.message.pending) {
      _timer ??= Timer.periodic(const Duration(seconds: 1), (_) {
        setState(() {
          _nowTick = DateTime.now().millisecondsSinceEpoch;
        });
      });
    } else {
      _timer?.cancel();
      _timer = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final message = widget.message;
    final onApproval = widget.onApproval;
    final processSummary = message.segments
        .where((segment) =>
            segment.type == 'status' &&
            (segment.stepId == 'final-summary' ||
                segment.stepId == 'runtime-status'))
        .firstOrNull;
    final visibleSegments = message.segments.where((s) {
      if (s.type == 'text' && (s.text ?? '').trim().isEmpty) return false;
      if (s.stepId == 'initial-thinking') {
        return false;
      }
      if (s.type == 'status' && s.stepId == 'final-summary') return false;
      if (_isProcessSegment(s) && !_shouldShowProcessSegment(s)) return false;
      return true;
    }).toList();

    var groups = _buildContentGroups(visibleSegments, message.pending);

    final hasInlineTextSegment = visibleSegments.any((s) =>
        s.type == 'text' &&
        !_isProcessTextSegment(s) &&
        (s.text ?? '').trim().isNotEmpty);
    final finalText = hasInlineTextSegment ? '' : _finalContentText(message);
    final hasVisibleContent = visibleSegments.any((segment) {
      if (_isProcessSegment(segment)) return true;
      return segment.type != 'text' || (segment.text ?? '').trim().isNotEmpty;
    });
    final isThinking =
        message.pending && finalText.isEmpty && !hasVisibleContent;
    if (isThinking && groups.where((g) => g.isProcess).isEmpty) {
      groups = [_SegmentGroup.process(const <ChatSegment>[])];
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var index = 0; index < groups.length; index++) ...[
          if (groups[index].isProcess)
            _ProcessGroupCard(
                segments: groups[index].segments,
                pending: _processGroupPending(groups, index, message.pending),
                summarySegment: processSummary,
                nowTick: _nowTick,
                onApproval: onApproval)
          else
            ChatSegmentView(
                segment: groups[index].singleSegment, onApproval: onApproval),
          const SizedBox(height: 8),
        ],
        if (finalText.trim().isNotEmpty)
          _AssistantMarkdownText(text: finalText),
      ],
    );
  }
}

class _ProcessGroupCard extends StatelessWidget {
  const _ProcessGroupCard(
      {required this.segments,
      required this.pending,
      this.summarySegment,
      this.nowTick,
      this.onApproval});

  final List<ChatSegment> segments;
  final bool pending;
  final ChatSegment? summarySegment;
  final int? nowTick;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
    final summary = _summaryLabel(segments, pending, summarySegment, nowTick);
    final detailSegments = segments.where(_shouldRenderProcessDetail).toList();
    final bodyItems = _buildProcessBodyItems(detailSegments, pending: pending);
    final thinkingOnly = pending &&
        bodyItems.isNotEmpty &&
        bodyItems.every((item) => item.isStage && _isThinkingStage(item.segments));
    if (thinkingOnly) {
      return const _InlineThinkingText();
    }
    if (detailSegments.isEmpty && !pending) {
      return _ProcessSummaryCard(summary: summary, pending: pending);
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
          initiallyExpanded: pending,
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
            for (final item in bodyItems) ...[
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: item.isStage
                    ? _ProcessStageView(
                        item: item,
                        pending: pending,
                        onApproval: onApproval,
                      )
                    : ChatSegmentView(
                        segment: item.singleSegment,
                        compact: true,
                        onApproval: onApproval,
                      ),
              ),
              if (item.conclusion != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6, left: 16),
                  child:
                      _StageConclusion(text: _conclusionText(item.conclusion!)),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ProcessStageView extends StatelessWidget {
  const _ProcessStageView({
    required this.item,
    required this.pending,
    this.onApproval,
  });

  final _ProcessBodyItem item;
  final bool pending;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
    final stoppedByUser = _processStageStoppedByUser(item.segments);
    final titleColor = stoppedByUser ? AppColors.danger : AppColors.secondary;
    final dotColor = stoppedByUser
        ? AppColors.danger
        : _processStageRunning(item.segments)
            ? AppColors.warning
            : AppColors.successDeep;
    if (_isThinkingStage(item.segments)) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 3),
        child: Row(
          children: [
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: stoppedByUser ? AppColors.danger : AppColors.warning,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                _processStageTitle(item.segments, pending),
                style: TextStyle(
                  color: titleColor,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      );
    }
    return InkWell(
      borderRadius: BorderRadius.circular(AppRadius.md),
      onTap: () => _showStageSheet(context),
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 9, 10, 10),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadius.md),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: [
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: dotColor,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                _processStageTitle(item.segments, pending),
                style: TextStyle(
                  color: titleColor,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            Icon(Icons.chevron_right, size: 18, color: AppColors.muted),
          ],
        ),
      ),
    );
  }

  void _showStageSheet(BuildContext context) {
    final title = _processStageTitle(item.segments, pending);
    final visibleSegments = _visibleStageSegments(item.segments);
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => _ProcessStageSheet(
        title: title,
        segments: visibleSegments,
        onApproval: onApproval,
      ),
    );
  }
}

class _ProcessStageSheet extends StatelessWidget {
  const _ProcessStageSheet({
    required this.title,
    required this.segments,
    this.onApproval,
  });

  final String title;
  final List<ChatSegment> segments;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.82,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  title,
                  style: const TextStyle(
                    color: AppColors.secondary,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final segment in segments)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: ChatSegmentView(
                          segment: segment,
                          compact: true,
                          onApproval: onApproval,
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StageConclusion extends StatelessWidget {
  const _StageConclusion({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return const SizedBox.shrink();
    return _AssistantMarkdownText(text: trimmed);
  }
}

String _conclusionText(ChatSegment segment) {
  if (segment.type == 'thought' || segment.type == 'text') {
    return segment.text ?? '';
  }
  if (segment.type == 'error') return segment.message ?? '';
  return '';
}

class _ProcessSummaryCard extends StatelessWidget {
  const _ProcessSummaryCard({required this.summary, required this.pending});

  final String summary;
  final bool pending;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceMuted,
        borderRadius: BorderRadius.circular(AppRadius.lg),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
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

class _ProcessBodyItem {
  final bool isStage;
  final List<ChatSegment> segments;
  final ChatSegment? conclusion;

  const _ProcessBodyItem._({
    required this.isStage,
    required this.segments,
    this.conclusion,
  });

  factory _ProcessBodyItem.segment(ChatSegment segment) =>
      _ProcessBodyItem._(isStage: false, segments: [segment]);
  factory _ProcessBodyItem.stage(
          List<ChatSegment> segments, ChatSegment? conclusion) =>
      _ProcessBodyItem._(
          isStage: true, segments: segments, conclusion: conclusion);

  ChatSegment get singleSegment => segments.first;
}

List<_SegmentGroup> _buildContentGroups(
    List<ChatSegment> segments, bool pending) {
  final firstProcessIndex = segments.indexWhere(_isProcessSegment);
  if (firstProcessIndex < 0) {
    return [
      for (final segment in segments) _SegmentGroup.segment(segment),
    ];
  }

  var lastProcessIndex = firstProcessIndex;
  for (var index = firstProcessIndex + 1; index < segments.length; index++) {
    if (_isProcessSegment(segments[index])) lastProcessIndex = index;
  }
  final processEndIndex = pending
      ? segments.length - 1
      : _completedProcessEndIndex(segments, lastProcessIndex);

  return [
    for (final segment in segments.take(firstProcessIndex))
      _SegmentGroup.segment(segment),
    _SegmentGroup.process(
        segments.sublist(firstProcessIndex, processEndIndex + 1)),
    for (final segment in segments.skip(processEndIndex + 1))
      _SegmentGroup.segment(segment),
  ];
}

int _completedProcessEndIndex(
    List<ChatSegment> segments, int lastProcessIndex) {
  final lastIndex = segments.length - 1;
  final lastSegment = segments[lastIndex];
  if (lastIndex > lastProcessIndex &&
      lastSegment.type == 'text' &&
      (lastSegment.text ?? '').trim().isNotEmpty) {
    return lastIndex - 1;
  }
  return lastProcessIndex;
}

bool _processGroupPending(
    List<_SegmentGroup> groups, int groupIndex, bool messagePending) {
  if (!messagePending) return false;
  for (final group in groups.skip(groupIndex + 1)) {
    if (group.isProcess) continue;
    final segment = group.singleSegment;
    if (segment.type == 'text' && (segment.text ?? '').trim().isNotEmpty) {
      return false;
    }
  }
  return true;
}

List<_ProcessBodyItem> _buildProcessBodyItems(List<ChatSegment> segments,
    {bool pending = false}) {
  final items = <_ProcessBodyItem>[];
  var stageRun = <ChatSegment>[];
  String? stageKind;
  final hasExecution = segments.any(_isExecutionStageSegment);
  void flushStageRun() {
    if (stageRun.isEmpty) return;
    items.add(_ProcessBodyItem.stage(stageRun, null));
    stageRun = <ChatSegment>[];
    stageKind = null;
  }

  void attachConclusion(ChatSegment segment) {
    final latest = items.isEmpty ? null : items.last;
    if (latest != null && latest.isStage) {
      items[items.length - 1] =
          _ProcessBodyItem.stage(latest.segments, segment);
      return;
    }
    items.add(_ProcessBodyItem.segment(segment));
  }

  for (final segment in segments) {
    if (_isProcessConclusionSegment(segment)) {
      flushStageRun();
      attachConclusion(segment);
      continue;
    }
    if (_isExecutionConclusionSegment(segment)) {
      flushStageRun();
      attachConclusion(segment);
      continue;
    }
    if (_isProcessStageSegment(segment)) {
      if (hasExecution && _isThinkingStageSegment(segment)) continue;
      final nextKind =
          _isThinkingStageSegment(segment) ? 'thinking' : 'execution';
      if (stageKind != null && stageKind != nextKind) flushStageRun();
      stageKind = nextKind;
      stageRun.add(segment);
      continue;
    }
    flushStageRun();
    items.add(_ProcessBodyItem.segment(segment));
  }
  flushStageRun();
  // pending 且最后一个 stage 无 running item 时，追加"正在思考"占位 stage
  // 对应 Codex turn/started 后、下一个 item/started 前的空档期
  if (pending) {
    final lastItem = items.isEmpty ? null : items.last;
    final lastStageHasRunning = lastItem != null &&
        lastItem.isStage &&
        lastItem.segments.any((s) =>
            (s.type == 'status' && s.status == 'running') ||
            (s.type == 'tool' && s.status == 'running') ||
            (s.type == 'approval' && s.status == 'pending'));
    final lastStageHasConclusion = lastItem?.conclusion != null;
    if (!lastStageHasRunning && !lastStageHasConclusion) {
      items.add(_ProcessBodyItem.stage([
        ChatSegment(
          type: 'status',
          stepId: 'pending-thinking-placeholder',
          label: '正在思考',
          icon: 'think',
          status: 'running',
          startedAt: DateTime.now().toIso8601String(),
          rawItemType: 'reasoning',
        ),
      ], null));
    }
  }
  return items;
}

bool _isProcessStageSegment(ChatSegment segment) {
  return segment.type == 'thought' ||
      segment.type == 'status' ||
      segment.type == 'tool' ||
      segment.type == 'approval' ||
      segment.type == 'error';
}

bool _isThinkingStageSegment(ChatSegment segment) {
  return (segment.type == 'thought' &&
          !_isProcessCommentaryThought(segment) &&
          !_isExecutionConclusionSegment(segment)) ||
      _isThinkingStatusSegment(segment);
}

bool _isExecutionConclusionSegment(ChatSegment segment) {
  return segment.type == 'thought' &&
      (segment.stepId ?? '').startsWith('agent-message-');
}

bool _isThinkingStatusSegment(ChatSegment segment) {
  return segment.type == 'status' &&
      _isThinkingRawItemType(segment.rawItemType);
}

bool _isExecutionStageSegment(ChatSegment segment) {
  return segment.type == 'tool' ||
      segment.type == 'approval' ||
      segment.type == 'error' ||
      (segment.type == 'status' && !_isThinkingStatusSegment(segment));
}

bool _isProcessConclusionSegment(ChatSegment segment) {
  return _isProcessTextSegment(segment) || _isProcessCommentaryThought(segment);
}

bool _isProcessCommentaryThought(ChatSegment segment) {
  return segment.type == 'thought' &&
      (segment.title == '执行说明' || segment.title == '中间结论');
}

String _processStageTitle(List<ChatSegment> segments, bool pending) {
  final runningThinking = segments
      .where((segment) =>
          _isThinkingStatusSegment(segment) && segment.status == 'running')
      .firstOrNull;
  if (runningThinking != null) return '正在思考';
  final toolSegments =
      segments.where((segment) => segment.type == 'tool').toList();
  final aggregateTitle = _aggregateToolStageTitle(toolSegments);
  if (aggregateTitle.isNotEmpty) return aggregateTitle;
  final runningTool =
      toolSegments.where((segment) => segment.status == 'running').firstOrNull;
  if (runningTool != null) return _toolStageTitle(runningTool);

  final pendingApproval = segments
      .where((segment) =>
          segment.type == 'approval' && segment.status == 'pending')
      .firstOrNull;
  if (pendingApproval != null) {
    return pendingApproval.approvalKind == 'fileChange' ? '正在修改文件' : '正在等待命令确认';
  }

  final erroredTool =
      toolSegments.where((segment) => segment.status == 'error').firstOrNull;
  if (erroredTool != null) return _toolStageTitle(erroredTool);

  final latestTool = toolSegments.toList().reversed.firstOrNull;
  if (latestTool != null) return _toolStageTitle(latestTool);

  final latestStatus = segments
      .where((segment) => segment.type == 'status')
      .toList()
      .reversed
      .firstOrNull;
  if (latestStatus != null && _isUserStoppedStatus(latestStatus)) {
    return '用户主动停止';
  }
  final statusLabel = latestStatus?.label?.trim();
  if (statusLabel != null && statusLabel.isNotEmpty) return statusLabel;

  if (segments.any((segment) =>
      segment.type == 'thought' &&
      !_isProcessCommentaryThought(segment) &&
      !_isExecutionConclusionSegment(segment))) {
    return '正在思考';
  }
  return pending ? '正在处理' : '已处理';
}

String _aggregateToolStageTitle(List<ChatSegment> segments) {
  if (segments.isEmpty) return '';
  var read = 0;
  var search = 0;
  var edit = 0;
  var command = 0;
  var hasRunning = false;
  var hasError = false;
  for (final segment in segments) {
    if (segment.status == 'running') hasRunning = true;
    if (segment.status == 'error') hasError = true;
    switch (_toolOperationKind(segment)) {
      case 'read':
        read += 1;
        break;
      case 'search':
        search += 1;
        break;
      case 'edit':
        edit += 1;
        break;
      default:
        command += 1;
    }
  }
  final parts = <String>[
    if (read > 0) '读取 $read 个文件',
    if (search > 0) '搜索 $search 次文件',
    if (edit > 0) '修改 $edit 个文件',
    if (command > 0) '运行 $command 条命令',
  ];
  if (parts.isEmpty) return '';
  final prefix = hasError
      ? '部分失败：'
      : hasRunning
          ? '正在'
          : '已';
  return '$prefix${parts.join('，')}';
}

String _toolOperationKind(ChatSegment segment) {
  final command = _normalizeCommandForTitle(segment.command ?? '');
  final fileChanges = _extractFileChangePaths(segment.diff);
  final toolName = segment.toolName ?? '';
  if (toolName.contains('修改') || (fileChanges?.isNotEmpty ?? false)) {
    return 'edit';
  }
  if (RegExp(r'^(Get-Content|cat|type|head|tail|sed\b|Select-String\b)',
          caseSensitive: false)
      .hasMatch(command)) {
    return 'read';
  }
  if (RegExp(r'^(rg|grep|findstr|fd|find\b|Get-ChildItem|ls\b|dir\b)',
          caseSensitive: false)
      .hasMatch(command)) {
    return 'search';
  }
  if (RegExp(r'\b(Get-Content|cat|type)\b', caseSensitive: false)
      .hasMatch(command)) {
    return 'read';
  }
  if (RegExp(r'\b(rg|grep|findstr|Get-ChildItem)\b', caseSensitive: false)
      .hasMatch(command)) {
    return 'search';
  }
  return 'command';
}

String _toolStageTitle(ChatSegment segment) {
  final status = segment.status ?? 'success';
  final verb = status == 'running' ? '正在' : '已';
  final toolName = segment.toolName ?? '工具调用';
  final commandText = _normalizeCommandForTitle(segment.command ?? '');
  final fileChanges = _extractFileChangePaths(segment.diff);
  if (toolName.contains('修改') ||
      toolName.contains('文件') ||
      fileChanges != null) {
    if (status == 'error') return '修改文件失败';
    if (fileChanges != null && fileChanges.isNotEmpty) {
      final fileName = fileChanges.first.split(RegExp(r'[\\/]')).last;
      return '$verb修改 $fileName';
    }
    return '$verb修改文件';
  }
  if (toolName.contains('扫描')) {
    if (status == 'error') return '扫描项目失败';
    return '$verb扫描项目';
  }
  if (toolName.contains('命令') || commandText.isNotEmpty) {
    if (status == 'error') return '运行命令失败';
    if (commandText.isNotEmpty) {
      final shortCommand = commandText.split(RegExp(r'\s+')).take(3).join(' ');
      return '$verb运行 $shortCommand';
    }
    return '$verb运行命令';
  }
  if (status == 'error') return segment.summary ?? '处理失败 $toolName';
  return segment.summary ?? '$verb处理 $toolName';
}

String _normalizeCommandForTitle(String command) {
  final trimmed = command
      .replaceFirst(RegExp(r'^/usr/bin/(bash|sh)\s+-lc\s+'), '')
      .replaceFirst(RegExp(r'^bash\s+-lc\s+'), '')
      .trim();
  final cleaned = _unquoteCommand(trimmed);
  final powershell = RegExp(
          r'^(?:"?[^"]*\\powershell(?:\.exe)?"?\s+)?-Command\s+([\s\S]+)$',
          caseSensitive: false)
      .firstMatch(cleaned);
  return _unquoteCommand((powershell?.group(1) ?? cleaned).trim());
}

String _commandOperationTitle(String command, String status) {
  final verb = status == 'running' ? '正在' : '已';
  final target = _commandTarget(command);
  if (RegExp(r'^(Get-Content|cat|type|head|tail|sed\b|Select-String\b)',
          caseSensitive: false)
      .hasMatch(command)) {
    if (status == 'error') {
      return target.isNotEmpty ? '读取 $target 失败' : '读取文件失败';
    }
    return target.isNotEmpty ? '$verb读取 $target' : '$verb读取文件';
  }
  if (RegExp(r'^(rg|grep|findstr|fd|find\b|Get-ChildItem|ls\b|dir\b)',
          caseSensitive: false)
      .hasMatch(command)) {
    if (status == 'error') return '搜索文件失败';
    return '$verb搜索文件';
  }
  if (RegExp(r'\b(Get-Content|cat|type)\b', caseSensitive: false)
      .hasMatch(command)) {
    if (status == 'error') {
      return target.isNotEmpty ? '读取 $target 失败' : '读取文件失败';
    }
    return target.isNotEmpty ? '$verb读取 $target' : '$verb读取文件';
  }
  if (RegExp(r'\b(rg|grep|findstr|Get-ChildItem)\b', caseSensitive: false)
      .hasMatch(command)) {
    if (status == 'error') return '搜索文件失败';
    return '$verb搜索文件';
  }
  return '';
}

String _commandTarget(String command) {
  final tokens = RegExp(r'''("[^"]+"|'[^']+'|\S+)''')
      .allMatches(command)
      .map((match) => _unquoteCommand(match.group(0) ?? ''))
      .toList();
  final commandNames = RegExp(
      r'^(Get-Content|cat|type|head|tail|sed|Select-String|PowerShell:)$',
      caseSensitive: false);
  final optionsWithValue = RegExp(
      r'^(-Encoding|-TotalCount|-Tail|-Head|-Filter|-Include|-Exclude|-Context|-Pattern)$',
      caseSensitive: false);
  var skipNext = false;
  for (final token in tokens) {
    if (token.isEmpty || commandNames.hasMatch(token)) continue;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (optionsWithValue.hasMatch(token)) {
      skipNext = true;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (RegExp(r'^\d+$').hasMatch(token)) continue;
    return token.split(RegExp(r'[\\/]')).last;
  }
  return '';
}

List<String>? _extractFileChangePaths(String? diff) {
  if (diff == null || diff.isEmpty) return null;
  final paths = <String>[];
  for (final line in diff.split('\n')) {
    final match = RegExp(r'^diff --git a/(.+?) b/(.+)$').firstMatch(line);
    if (match != null) {
      paths.add(match.group(2)!);
      continue;
    }
    final patchMatch = RegExp(r'^\+\+\+ b/(.+)$').firstMatch(line);
    if (patchMatch != null) {
      paths.add(patchMatch.group(1)!);
    }
  }
  return paths.isEmpty ? null : paths;
}

bool _processStageRunning(List<ChatSegment> segments) {
  return segments.any((segment) =>
      (segment.type == 'tool' && segment.status == 'running') ||
      (segment.type == 'approval' && segment.status == 'pending') ||
      (_isThinkingStatusSegment(segment) && segment.status == 'running'));
}

bool _processStageStoppedByUser(List<ChatSegment> segments) {
  return segments.any(_isUserStoppedStatus);
}

bool _isThinkingStage(List<ChatSegment> segments) {
  return segments.isNotEmpty && segments.every(_isThinkingStageSegment);
}

List<ChatSegment> _visibleStageSegments(List<ChatSegment> segments) {
  return _isThinkingStage(segments) ? const <ChatSegment>[] : segments;
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
    final summarySegment = segments
        .where((segment) =>
            segment.type == 'status' &&
            (segment.stepId == 'final-summary' ||
                segment.stepId == 'runtime-status'))
        .firstOrNull;
    final summary =
        _summaryLabel(processSegments, pending, summarySegment, null);
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
          : _AssistantMarkdownText(text: text),
    );
  }
}

class _TextSegment extends StatelessWidget {
  const _TextSegment({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    if (text.trim().isEmpty) return const SizedBox.shrink();
    return _AssistantMarkdownText(text: text);
  }
}

class _AssistantMarkdownText extends StatelessWidget {
  const _AssistantMarkdownText({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final blocks = _cachedMarkdownBlocks(text);
    if (blocks.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var index = 0; index < blocks.length; index++)
          _MarkdownBlockView(
            block: blocks[index],
            isFirst: index == 0,
            isLast: index == blocks.length - 1,
          ),
      ],
    );
  }
}

class _MarkdownBlockView extends StatelessWidget {
  const _MarkdownBlockView({
    required this.block,
    required this.isFirst,
    required this.isLast,
  });

  final _MarkdownBlock block;
  final bool isFirst;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    return switch (block.type) {
      _MarkdownBlockType.heading => _MarkdownHeading(
          text: block.text,
          level: block.level,
          isFirst: isFirst,
          isLast: isLast,
        ),
      _MarkdownBlockType.list => _MarkdownList(
          items: block.items,
          ordered: block.ordered,
          isLast: isLast,
        ),
      _MarkdownBlockType.code => _MarkdownCodeBlock(
          text: block.text,
          isLast: isLast,
        ),
      _MarkdownBlockType.quote => _MarkdownQuote(
          text: block.text,
          isLast: isLast,
        ),
      _MarkdownBlockType.rule => _MarkdownRule(isLast: isLast),
      _MarkdownBlockType.table => _MarkdownTable(
          rows: block.rows,
          header: block.header,
          isLast: isLast,
        ),
      _ => _MarkdownParagraph(
          text: block.text,
          isLast: isLast,
        ),
    };
  }
}

class _MarkdownParagraph extends StatelessWidget {
  const _MarkdownParagraph({required this.text, required this.isLast});

  final String text;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: isLast ? 0 : 12),
      child: _InlineMarkdownText(
        text: text,
        style: _markdownTextStyle,
      ),
    );
  }
}

class _MarkdownHeading extends StatelessWidget {
  const _MarkdownHeading({
    required this.text,
    required this.level,
    required this.isFirst,
    required this.isLast,
  });

  final String text;
  final int level;
  final bool isFirst;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    final isH2 = level == 2;
    final heading = Padding(
      padding: EdgeInsets.only(
        top: isFirst ? 0 : (isH2 ? 18 : 14),
        bottom: isLast ? 0 : 8,
      ),
      child: _InlineMarkdownText(
        text: text,
        style: TextStyle(
          color: AppColors.ink,
          fontSize: isH2 ? 16 : 14,
          height: 1.35,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
    if (!isH2) return heading;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        heading,
        if (!isLast)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Divider(height: 1, thickness: 1, color: AppColors.divider),
          ),
      ],
    );
  }
}

class _MarkdownList extends StatelessWidget {
  const _MarkdownList({
    required this.items,
    required this.ordered,
    required this.isLast,
  });

  final List<String> items;
  final bool ordered;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: isLast ? 0 : 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var index = 0; index < items.length; index++)
            Padding(
              padding: EdgeInsets.only(top: index == 0 ? 0 : 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 22,
                    child: Text(
                      ordered ? '${index + 1}.' : '•',
                      textAlign: TextAlign.right,
                      style: const TextStyle(
                        color: AppColors.secondary,
                        fontSize: 13,
                        height: 1.68,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: _InlineMarkdownText(
                      text: items[index],
                      style: _markdownTextStyle.copyWith(height: 1.68),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _MarkdownCodeBlock extends StatelessWidget {
  const _MarkdownCodeBlock({required this.text, required this.isLast});

  final String text;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: EdgeInsets.only(top: 2, bottom: isLast ? 0 : 14),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: AppColors.border),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: SelectableText(
          text.isEmpty ? ' ' : text,
          style: const TextStyle(
            color: AppColors.secondary,
            fontFamily: 'monospace',
            fontSize: 12,
            height: 1.6,
          ),
        ),
      ),
    );
  }
}

class _MarkdownQuote extends StatelessWidget {
  const _MarkdownQuote({required this.text, required this.isLast});

  final String text;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: EdgeInsets.only(bottom: isLast ? 0 : 14),
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: const BoxDecoration(
        color: AppColors.infoSoft,
        borderRadius: BorderRadius.only(
          topRight: Radius.circular(AppRadius.md),
          bottomRight: Radius.circular(AppRadius.md),
        ),
        border: Border(
          left: BorderSide(color: Color(0xff93c5fd), width: 3),
        ),
      ),
      child: _InlineMarkdownText(
        text: text,
        style: const TextStyle(
          color: AppColors.secondary,
          fontSize: 13,
          height: 1.65,
        ),
      ),
    );
  }
}

class _MarkdownRule extends StatelessWidget {
  const _MarkdownRule({required this.isLast});

  final bool isLast;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(top: 6, bottom: isLast ? 6 : 18),
      child: const Divider(height: 1, thickness: 1, color: AppColors.divider),
    );
  }
}

class _MarkdownTable extends StatelessWidget {
  const _MarkdownTable({
    required this.rows,
    required this.header,
    required this.isLast,
  });

  final List<List<String>> rows;
  final bool header;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return const SizedBox.shrink();
    final headerCells = header ? rows.first : const <String>[];
    final dataRows = header && rows.length > 1 ? rows.skip(1).toList() : rows;
    return Container(
      width: double.infinity,
      margin: EdgeInsets.only(top: 2, bottom: isLast ? 0 : 14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: AppColors.border),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.md),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var rowIndex = 0; rowIndex < dataRows.length; rowIndex++)
              _MarkdownTableRow(
                cells: dataRows[rowIndex],
                headerCells: headerCells,
                hasHeader: header,
                isHeaderOnly: header && rows.length == 1,
                isLast: rowIndex == dataRows.length - 1,
              ),
          ],
        ),
      ),
    );
  }
}

class _MarkdownTableRow extends StatelessWidget {
  const _MarkdownTableRow({
    required this.cells,
    required this.headerCells,
    required this.hasHeader,
    required this.isHeaderOnly,
    required this.isLast,
  });

  final List<String> cells;
  final List<String> headerCells;
  final bool hasHeader;
  final bool isHeaderOnly;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    final cellCount =
        cells.length > headerCells.length ? cells.length : headerCells.length;
    final pairs = <_MarkdownTableCellPair>[];
    for (var index = 0; index < cellCount; index++) {
      final label = hasHeader && !isHeaderOnly && index < headerCells.length
          ? headerCells[index].trim()
          : '';
      final value = index < cells.length ? cells[index].trim() : '';
      if (label.isEmpty && value.isEmpty) {
        continue;
      }
      pairs.add(_MarkdownTableCellPair(label: label, value: value));
    }

    if (pairs.isEmpty) {
      return const SizedBox.shrink();
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
      decoration: BoxDecoration(
        color: isHeaderOnly ? AppColors.surfaceMuted : AppColors.surface,
        border: Border(
          bottom: isLast
              ? BorderSide.none
              : const BorderSide(color: AppColors.divider),
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var index = 0; index < pairs.length; index++)
            Padding(
              padding: EdgeInsets.only(top: index == 0 ? 0 : 8),
              child: hasHeader && !isHeaderOnly
                  ? Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          pairs[index].label,
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 11,
                            height: 1.35,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(height: 2),
                        _InlineMarkdownText(
                          text: pairs[index].value,
                          style: const TextStyle(
                            color: AppColors.secondary,
                            fontSize: 12,
                            height: 1.55,
                          ),
                        ),
                      ],
                    )
                  : _InlineMarkdownText(
                      text: pairs[index].value,
                      style: TextStyle(
                        color: AppColors.secondary,
                        fontSize: 12,
                        height: 1.55,
                        fontWeight:
                            isHeaderOnly ? FontWeight.w800 : FontWeight.w400,
                      ),
                    ),
            ),
        ],
      ),
    );
  }
}

class _MarkdownTableCellPair {
  const _MarkdownTableCellPair({required this.label, required this.value});

  final String label;
  final String value;
}

class _InlineMarkdownText extends StatelessWidget {
  const _InlineMarkdownText({required this.text, required this.style});

  final String text;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(style: style, children: _inlineSpans(text, style)),
      textScaler: MediaQuery.textScalerOf(context),
    );
  }
}

final _markdownBlockCache = <String, List<_MarkdownBlock>>{};
const _markdownBlockCacheLimit = 80;

List<_MarkdownBlock> _cachedMarkdownBlocks(String text) {
  final cached = _markdownBlockCache.remove(text);
  if (cached != null) {
    _markdownBlockCache[text] = cached;
    return cached;
  }
  final blocks = _parseMarkdownBlocks(text);
  if (text.length >= 256) {
    _markdownBlockCache[text] = blocks;
    if (_markdownBlockCache.length > _markdownBlockCacheLimit) {
      _markdownBlockCache.remove(_markdownBlockCache.keys.first);
    }
  }
  return blocks;
}

enum _MarkdownBlockType { paragraph, heading, list, code, quote, rule, table }

class _MarkdownBlock {
  const _MarkdownBlock._({
    required this.type,
    this.text = '',
    this.level = 3,
    this.ordered = false,
    this.items = const [],
    this.rows = const [],
    this.header = false,
  });

  factory _MarkdownBlock.paragraph(String text) =>
      _MarkdownBlock._(type: _MarkdownBlockType.paragraph, text: text);
  factory _MarkdownBlock.heading(int level, String text) => _MarkdownBlock._(
      type: _MarkdownBlockType.heading, level: level, text: text);
  factory _MarkdownBlock.list(bool ordered, List<String> items) =>
      _MarkdownBlock._(
          type: _MarkdownBlockType.list,
          ordered: ordered,
          items: List.unmodifiable(items));
  factory _MarkdownBlock.code(String text) =>
      _MarkdownBlock._(type: _MarkdownBlockType.code, text: text);
  factory _MarkdownBlock.quote(String text) =>
      _MarkdownBlock._(type: _MarkdownBlockType.quote, text: text);
  factory _MarkdownBlock.rule() =>
      const _MarkdownBlock._(type: _MarkdownBlockType.rule);
  factory _MarkdownBlock.table(List<List<String>> rows, bool header) =>
      _MarkdownBlock._(
          type: _MarkdownBlockType.table,
          rows: List.unmodifiable(rows.map(List.unmodifiable)),
          header: header);

  final _MarkdownBlockType type;
  final String text;
  final int level;
  final bool ordered;
  final List<String> items;
  final List<List<String>> rows;
  final bool header;
}

class _InlinePart {
  const _InlinePart(this.text, {this.code = false, this.strong = false});

  final String text;
  final bool code;
  final bool strong;
}

const _markdownTextStyle = TextStyle(
  color: AppColors.ink,
  fontSize: 13,
  height: 1.62,
);

List<_MarkdownBlock> _parseMarkdownBlocks(String text) {
  final blocks = <_MarkdownBlock>[];
  final lines = text.replaceAll('\r\n', '\n').split('\n');
  var paragraph = <String>[];
  var listItems = <String>[];
  var listOrdered = false;
  var codeLines = <String>[];
  var quoteLines = <String>[];
  var tableRows = <List<String>>[];
  var inCode = false;

  void flushParagraph() {
    if (paragraph.isEmpty) return;
    blocks.add(_MarkdownBlock.paragraph(paragraph.join('\n').trim()));
    paragraph = <String>[];
  }

  void flushList() {
    if (listItems.isEmpty) return;
    blocks.add(_MarkdownBlock.list(listOrdered, listItems));
    listItems = <String>[];
  }

  void flushQuote() {
    if (quoteLines.isEmpty) return;
    blocks.add(_MarkdownBlock.quote(quoteLines.join('\n').trim()));
    quoteLines = <String>[];
  }

  void flushTable() {
    if (tableRows.isEmpty) return;
    final hasDivider = tableRows.length > 1 &&
        tableRows[1].every((cell) => RegExp(r'^:?-{3,}:?$').hasMatch(cell));
    blocks.add(_MarkdownBlock.table(
      hasDivider ? [tableRows[0], ...tableRows.skip(2)] : tableRows,
      hasDivider,
    ));
    tableRows = <List<String>>[];
  }

  void flushInlineBlocks() {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  }

  for (final line in lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        blocks.add(_MarkdownBlock.code(codeLines.join('\n')));
        codeLines = <String>[];
        inCode = false;
      } else {
        flushInlineBlocks();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.add(line);
      continue;
    }

    final trimmed = line.trim();
    if (trimmed.isEmpty) {
      flushInlineBlocks();
      continue;
    }
    if (RegExp(r'^---+$').hasMatch(trimmed)) {
      flushInlineBlocks();
      blocks.add(_MarkdownBlock.rule());
      continue;
    }

    final hashHeading = RegExp(r'^(#{2,3})\s+(.+)$').firstMatch(trimmed);
    if (hashHeading != null) {
      flushInlineBlocks();
      blocks.add(_MarkdownBlock.heading(
          hashHeading.group(1)!.length, hashHeading.group(2)!));
      continue;
    }

    final boldHeading = RegExp(r'^\*\*(.+)\*\*$').firstMatch(trimmed);
    if (boldHeading != null) {
      flushInlineBlocks();
      blocks.add(_MarkdownBlock.heading(3, boldHeading.group(1)!));
      continue;
    }

    final quote = RegExp(r'^>\s?(.*)$').firstMatch(trimmed);
    if (quote != null) {
      flushParagraph();
      flushList();
      flushTable();
      quoteLines.add(quote.group(1)!);
      continue;
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushParagraph();
      flushList();
      flushQuote();
      tableRows.add(trimmed
          .substring(1, trimmed.length - 1)
          .split('|')
          .map((cell) => cell.trim())
          .toList());
      continue;
    }

    final unordered = RegExp(r'^[-*]\s+(.+)$').firstMatch(trimmed);
    final ordered = RegExp(r'^\d+[.)]\s+(.+)$').firstMatch(trimmed);
    if (unordered != null || ordered != null) {
      flushParagraph();
      flushQuote();
      flushTable();
      final isOrdered = ordered != null;
      if (listItems.isNotEmpty && listOrdered != isOrdered) flushList();
      listOrdered = isOrdered;
      listItems.add((ordered ?? unordered)!.group(1)!.trim());
      continue;
    }

    flushList();
    flushQuote();
    flushTable();
    paragraph.add(line);
  }

  flushInlineBlocks();
  if (inCode) blocks.add(_MarkdownBlock.code(codeLines.join('\n')));
  return blocks;
}

List<TextSpan> _inlineSpans(String text, TextStyle baseStyle) {
  final parts = <_InlinePart>[];
  final pattern = RegExp(r'(`([^`]+)`)|(\*\*([^*]+)\*\*)');
  var lastIndex = 0;
  for (final match in pattern.allMatches(text)) {
    if (match.start > lastIndex) {
      parts.add(_InlinePart(text.substring(lastIndex, match.start)));
    }
    final code = match.group(2);
    final strong = match.group(4);
    if (code != null) {
      parts.add(_InlinePart(code, code: true));
    } else if (strong != null) {
      parts.add(_InlinePart(strong, strong: true));
    }
    lastIndex = match.end;
  }
  if (lastIndex < text.length) {
    parts.add(_InlinePart(text.substring(lastIndex)));
  }

  return [
    for (final part in parts)
      TextSpan(
        text: part.text,
        style: part.code
            ? baseStyle.copyWith(
                color: AppColors.ink,
                fontFamily: 'monospace',
                fontSize: (baseStyle.fontSize ?? 13) * 0.92,
                backgroundColor: AppColors.surfaceMuted,
              )
            : part.strong
                ? baseStyle.copyWith(
                    color: AppColors.ink,
                    fontWeight: FontWeight.w800,
                  )
                : baseStyle,
      ),
  ];
}

class _StatusSegment extends StatelessWidget {
  const _StatusSegment({required this.segment});

  final ChatSegment segment;

  @override
  Widget build(BuildContext context) {
    final stoppedByUser = _isUserStoppedStatus(segment);
    final icon = switch (segment.icon) {
      'check' => Icons.check_circle_outline,
      'warn' => Icons.warning_amber_rounded,
      'search' => Icons.search,
      'edit' => Icons.edit_outlined,
      'read' => Icons.article_outlined,
      _ => Icons.circle_outlined,
    };
    final color = _statusColor(segment, stoppedByUser);
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
                stoppedByUser
                    ? '用户主动停止'
                    : segment.label ?? segment.text ?? 'AI 正在执行',
                style: TextStyle(
                    color:
                        stoppedByUser ? AppColors.danger : AppColors.secondary,
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

Color _statusColor(ChatSegment segment, bool stoppedByUser) {
  if (stoppedByUser) return AppColors.danger;
  if (segment.icon == 'warn') return AppColors.warningDeep;
  if (segment.icon == 'check') return AppColors.successDeep;
  return AppColors.muted;
}

bool _isUserStoppedStatus(ChatSegment segment) {
  final label = segment.label ?? segment.text ?? '';
  return segment.stepId == 'interrupted' ||
      segment.status == 'canceled' ||
      label == '用户主动停止' ||
      label == '已中断';
}

class _ToolSegment extends StatelessWidget {
  const _ToolSegment({required this.segment, required this.compact});

  final ChatSegment segment;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final diff = _toolDiffText(segment);
    if (diff.trim().isNotEmpty) {
      return _DiffBlock(diff);
    }
    final failed = segment.status == 'error';
    final running = segment.status == 'running';
    final title = _toolTitle(segment);
    final meta = _toolMeta(segment);
    final hasDetails = _toolHasDetails(segment);
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
          if (hasDetails) ...[
            const SizedBox(width: 8),
            const Icon(Icons.chevron_right, size: 18, color: AppColors.muted),
          ],
        ],
      ),
    );
    if (!hasDetails) return line;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.md),
        onTap: () => _showToolDetailsSheet(context, segment),
        child: line,
      ),
    );
  }
}

void _showToolDetailsSheet(BuildContext context, ChatSegment segment) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (ctx) => _ToolDetailsSheet(segment: segment),
  );
}

class _ToolDetailsSheet extends StatelessWidget {
  const _ToolDetailsSheet({required this.segment});

  final ChatSegment segment;

  @override
  Widget build(BuildContext context) {
    final visibleInput = _toolVisibleInput(segment);
    final visibleOutput = _toolVisibleOutput(segment);
    final diff = _toolDiffText(segment);
    final hasDiff = diff.trim().isNotEmpty;
    final title = _toolTitle(segment);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.78,
          ),
          child: ListView(
            shrinkWrap: true,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(
                      color: AppColors.primarySoftSolid,
                      borderRadius: BorderRadius.circular(AppRadius.lg),
                    ),
                    child: const Icon(Icons.terminal,
                        size: 18, color: AppColors.primary),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w800,
                            color: AppColors.ink,
                            height: 1.35,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          _toolStatusLabel(segment),
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 12,
                            height: 1.35,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              if (!hasDiff && (segment.command ?? '').trim().isNotEmpty)
                _SheetSection(title: '命令', child: _CodeBlock(segment.command!)),
              if (!hasDiff && (segment.summary ?? '').trim().isNotEmpty)
                _SheetSection(child: _DetailBlock(segment.summary!)),
              if (!hasDiff && visibleInput.trim().isNotEmpty)
                _SheetSection(title: '输入', child: _CodeBlock(visibleInput)),
              if (!hasDiff && visibleOutput.trim().isNotEmpty)
                _SheetSection(title: '输出', child: _CodeBlock(visibleOutput)),
              if (hasDiff) _SheetSection(title: '变更', child: _DiffBlock(diff)),
            ],
          ),
        ),
      ),
    );
  }
}

class _SheetSection extends StatelessWidget {
  const _SheetSection({this.title, required this.child});

  final String? title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(
                title!,
                style: const TextStyle(
                  color: AppColors.secondary,
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          child,
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
        padding: isUser || isError ? const EdgeInsets.all(12) : EdgeInsets.zero,
        decoration: BoxDecoration(
          color: isUser
              ? AppColors.primary
              : isError
                  ? AppColors.dangerSoft
                  : Colors.transparent,
          borderRadius: BorderRadius.circular(12),
          border: isError ? Border.all(color: const Color(0xffffcdd2)) : null,
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
    return const _InlineThinkingText();
  }
}

class _InlineThinkingText extends StatefulWidget {
  const _InlineThinkingText();

  @override
  State<_InlineThinkingText> createState() => _InlineThinkingTextState();
}

class _InlineThinkingTextState extends State<_InlineThinkingText>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1450),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 3),
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, child) {
          return ShaderMask(
            blendMode: BlendMode.srcIn,
            shaderCallback: (bounds) {
              final width = bounds.width <= 0 ? 1.0 : bounds.width;
              final dx = (_controller.value * 2.4 - 1.2) * width;
              return LinearGradient(
                colors: const [
                  AppColors.muted,
                  AppColors.secondary,
                  AppColors.muted,
                ],
                stops: const [0.0, 0.5, 1.0],
                begin: Alignment.centerLeft,
                end: Alignment.centerRight,
                transform: _SlidingGradientTransform(dx),
              ).createShader(bounds);
            },
            child: child,
          );
        },
        child: const Text(
          '正在思考',
          style: TextStyle(
            color: AppColors.secondary,
            fontSize: 12,
            fontWeight: FontWeight.w700,
            height: 1.35,
          ),
        ),
      ),
    );
  }
}

class _SlidingGradientTransform extends GradientTransform {
  const _SlidingGradientTransform(this.dx);

  final double dx;

  @override
  Matrix4? transform(Rect bounds, {TextDirection? textDirection}) {
    return Matrix4.translationValues(dx, 0, 0);
  }
}

String _finalContentText(ChatMessage message) {
  final text =
      _stripProcessTextFromFinalText(message.text ?? '', message.segments);
  if (text.isNotEmpty) return text;
  final textSegments = message.segments
      .where((segment) =>
          segment.type == 'text' && !_isProcessTextSegment(segment))
      .map((segment) => segment.text?.trim() ?? '')
      .where((value) => value.isNotEmpty)
      .toList();
  return textSegments.join('\n\n');
}

String _stripProcessTextFromFinalText(
    String text, List<ChatSegment> sourceSegments) {
  var cleaned = text.trim();
  if (cleaned.isEmpty) return cleaned;
  for (final segment in sourceSegments) {
    if (!_isProcessTextSegment(segment)) continue;
    cleaned = _removeTextBlock(cleaned, segment.text ?? '');
    if (cleaned.isEmpty) break;
  }
  return cleaned.trim();
}

String _removeTextBlock(String text, String block) {
  final target = block.trim();
  var source = text.trim();
  if (target.isEmpty || source.isEmpty) return source;
  if (source == target) return '';
  if (source.startsWith(target)) {
    return source.substring(target.length).trimLeft();
  }
  final surrounded = '\n\n$target\n\n';
  final index = source.indexOf(surrounded);
  if (index >= 0) {
    source =
        '${source.substring(0, index)}\n\n${source.substring(index + surrounded.length)}';
  }
  return source.trim();
}

bool _isProcessSegment(ChatSegment segment) {
  return _isProcessTextSegment(segment) ||
      segment.type == 'tool' ||
      segment.type == 'status' ||
      segment.type == 'thought' ||
      segment.type == 'error' ||
      segment.type == 'approval';
}

bool _isProcessTextSegment(ChatSegment segment) {
  final stepId = segment.stepId ?? '';
  return segment.type == 'text' &&
      (stepId.startsWith('process-text-') ||
          stepId.startsWith('thought-') ||
          stepId.startsWith('commentary-'));
}

bool _isUserMessageRawItemType(String? rawItemType) {
  return RegExp(r'^(?:userMessage|user_message)$', caseSensitive: false)
      .hasMatch(rawItemType ?? '');
}

bool _isCompletedThinkingStatusSegment(ChatSegment segment) {
  return segment.type == 'status' &&
      _isThinkingRawItemType(segment.rawItemType) &&
      segment.status != 'running';
}

bool _isThinkingRawItemType(String? rawItemType) {
  return RegExp(r'^(?:reasoning|thinking)$', caseSensitive: false)
      .hasMatch(rawItemType ?? '');
}

bool _shouldShowProcessSegment(ChatSegment segment) {
  if (segment.stepId == 'initial-thinking') {
    return false;
  }
  if (segment.type != 'status') return true;
  if (_isUserMessageRawItemType(segment.rawItemType)) return false;
  if (_isCompletedThinkingStatusSegment(segment)) return false;
  if (segment.stepId == 'runtime-status') return false;
  if (segment.stepId == 'final-summary') return false;
  final label = (segment.label ?? segment.text ?? '').trim();
  if (label.isEmpty) return false;
  if (label == '完成' || label == '已完成') {
    return false;
  }
  return true;
}

bool _shouldRenderProcessDetail(ChatSegment segment) {
  if (!_shouldShowProcessSegment(segment)) return false;
  if (segment.type == 'text') return (segment.text ?? '').trim().isNotEmpty;
  if (segment.type == 'status') {
    if (segment.stepId == 'runtime-status') return false;
    return ((segment.label ?? segment.text ?? '').trim().isNotEmpty) ||
        ((segment.detail ?? '').trim().isNotEmpty);
  }
  if (segment.type == 'thought') {
    return ((segment.text ?? segment.title ?? '').trim().isNotEmpty);
  }
  if (segment.type == 'tool' ||
      segment.type == 'error' ||
      segment.type == 'approval') {
    return true;
  }
  return false;
}

String _summaryLabel(List<ChatSegment> segments, bool pending,
    ChatSegment? finalSummary, int? nowTick) {
  final durationMs =
      _processGroupDurationMs(segments, pending, finalSummary, nowTick);
  final prefix = pending ? '正在处理' : '已处理';
  if (durationMs == null || durationMs <= 0) return prefix;
  return '$prefix ${_formatCompactDuration(durationMs)}';
}

int? _processGroupDurationMs(List<ChatSegment> segments, bool pending,
    ChatSegment? finalSummary, int? nowTick) {
  // 进行中：用 summary.startedAt + nowTick 实时计算（同桌面端）
  if (pending &&
      finalSummary != null &&
      (finalSummary.startedAt ?? '').isNotEmpty &&
      nowTick != null) {
    final startedAt = DateTime.tryParse(finalSummary.startedAt!);
    if (startedAt != null) {
      final diff = nowTick - startedAt.millisecondsSinceEpoch;
      if (diff > 0) return diff;
    }
  }
  // 完成态：优先用 summary.durationMs
  final summaryDuration = finalSummary?.durationMs;
  if (summaryDuration != null && summaryDuration > 0) {
    return summaryDuration;
  }
  // 兜底：取所有 tool/thought segment 的最大 durationMs（同桌面端）
  var maxDuration = 0;
  for (final segment in segments) {
    if (segment.type != 'tool' && segment.type != 'thought') continue;
    final duration = segment.durationMs ?? 0;
    if (duration > maxDuration) maxDuration = duration;
  }
  return maxDuration == 0 ? null : maxDuration;
}

String _formatCompactDuration(int durationMs) {
  if (durationMs < 1000) return '${durationMs}ms';
  final totalSeconds = (durationMs / 1000).round().clamp(1, 1 << 31);
  final seconds = totalSeconds % 60;
  final totalMinutes = totalSeconds ~/ 60;
  if (totalMinutes == 0) return '$seconds秒';
  final minutes = totalMinutes % 60;
  final hours = totalMinutes ~/ 60;
  if (hours == 0) {
    return seconds == 0 ? '$minutes分' : '$minutes分$seconds秒';
  }
  return seconds == 0 ? '$hours时$minutes分' : '$hours时$minutes分$seconds秒';
}

String _toolTitle(ChatSegment segment) {
  final patchFiles = _patchFileList(_toolDiffText(segment));
  final command = _normalizeCommandForTitle(segment.command ?? '');
  final displayCommand = patchFiles.isNotEmpty
      ? _shortFileList(patchFiles)
      : _shortenCommand(segment.command);
  final verb = segment.status == 'running' ? '正在' : '已';
  final toolName = segment.toolName ?? '工具调用';
  if (_isStdinContinuationSegment(segment)) {
    if (segment.status == 'error') return '读取命令输出失败';
    return segment.status == 'running' ? '正在读取命令输出' : '已读取命令输出';
  }
  if (toolName.contains('修改') || toolName.contains('文件')) {
    if (segment.status == 'error') {
      return displayCommand.isNotEmpty ? '修改 $displayCommand 失败' : '修改文件失败';
    }
    return displayCommand.isNotEmpty
        ? '${segment.status == 'running' ? '正在修改' : '已修改'} $displayCommand'
        : '${segment.status == 'running' ? '正在处理' : '已处理'}文件修改';
  }
  if (toolName.contains('命令') ||
      toolName.contains('command') ||
      (segment.command ?? '').isNotEmpty) {
    final operation =
        _commandOperationTitle(command, segment.status ?? 'success');
    if (operation.isNotEmpty) return operation;
    if (segment.status == 'error') {
      return displayCommand.isNotEmpty ? '运行失败 $displayCommand' : '运行命令失败';
    }
    return displayCommand.isNotEmpty ? '$verb运行 $displayCommand' : '$verb运行命令';
  }
  if (segment.status == 'error') return segment.summary ?? '处理失败 $toolName';
  return segment.summary ?? '$verb处理 $toolName';
}

typedef _ToolMetaItem = ({String kind, String text});

bool _toolHasDetails(ChatSegment segment) {
  return (segment.command ?? '').trim().isNotEmpty ||
      (segment.summary ?? '').trim().isNotEmpty ||
      _toolVisibleInput(segment).trim().isNotEmpty ||
      _toolVisibleOutput(segment).trim().isNotEmpty ||
      _toolDiffText(segment).trim().isNotEmpty;
}

String _toolStatusLabel(ChatSegment segment) {
  final meta = _toolMeta(segment).map((item) => item.text).join(' · ');
  final status = switch (segment.status) {
    'running' => '正在运行',
    'error' => '运行失败',
    _ => '已运行',
  };
  return meta.isEmpty ? status : '$status · $meta';
}

List<_ToolMetaItem> _toolMeta(ChatSegment segment) {
  final parts = <_ToolMetaItem>[];
  final stats = _diffStats(_toolDiffText(segment));
  final additions = segment.additions ?? stats.additions;
  final deletions = segment.deletions ?? stats.deletions;
  if (additions != null) parts.add((kind: 'add', text: '+$additions'));
  if (deletions != null) parts.add((kind: 'delete', text: '-$deletions'));
  if (segment.status == 'error') parts.add((kind: 'error', text: '失败'));
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
      RegExp(r'^\*\*\* (?:Add|Update|Delete) File: ').hasMatch(line);
}

String _approvalMeta(ChatSegment segment) {
  final parts = <String>[];
  if ((segment.cwd ?? '').isNotEmpty) parts.add('目录 ${segment.cwd}');
  if ((segment.grantRoot ?? '').isNotEmpty) {
    parts.add('授权 ${segment.grantRoot}');
  }
  if (segment.fileChanges.isNotEmpty) {
    parts.add('${segment.fileChanges.length} 个文件');
  }
  return parts.join(' · ');
}

String _shortenCommand(String? command) {
  final cleaned = _unquoteCommand((command ?? '')
      .replaceFirst(RegExp(r'^/usr/bin/(bash|sh)\s+-lc\s+'), '')
      .replaceFirst(RegExp(r'^bash\s+-lc\s+'), '')
      .trim());
  final powershell = RegExp(
    r'''^(?:"?[^"]*\\powershell(?:\.exe)?"?\s+)?-Command\s+([\s\S]+)$''',
    caseSensitive: false,
  ).firstMatch(cleaned);
  final unquoted = powershell == null
      ? cleaned
      : 'PowerShell: ${_unquoteCommand((powershell.group(1) ?? '').trim())}';
  return unquoted.length > 64 ? '${unquoted.substring(0, 61)}...' : unquoted;
}

String _unquoteCommand(String command) {
  final quoteMatch = RegExp(r'''^['"](.+)['"]$''').firstMatch(command);
  return quoteMatch?.group(1) ?? command;
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    for (final item in this) {
      return item;
    }
    return null;
  }
}
