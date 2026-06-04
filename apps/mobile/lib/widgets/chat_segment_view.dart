import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import 'app_theme.dart';

class ChatSegmentView extends StatelessWidget {
  const ChatSegmentView({super.key, required this.segment});

  final ChatSegment segment;

  @override
  Widget build(BuildContext context) {
    return switch (segment.type) {
      'status' => _StatusSegment(segment: segment),
      'tool' => _ToolSegment(segment: segment),
      'thought' => _ThoughtSegment(segment: segment),
      'error' => _ErrorSegment(segment: segment),
      _ => SelectableText(
          segment.text ?? segment.message ?? '',
          style: const TextStyle(fontSize: 14, height: 1.55),
        ),
    };
  }
}

class _StatusSegment extends StatelessWidget {
  const _StatusSegment({required this.segment});

  final ChatSegment segment;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.sync, color: AppColors.muted, size: 16),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            segment.label ?? segment.text ?? 'AI 正在执行',
            style: const TextStyle(color: AppColors.muted, fontSize: 13, height: 1.45),
          ),
        ),
      ],
    );
  }
}

class _ToolSegment extends StatelessWidget {
  const _ToolSegment({required this.segment});

  final ChatSegment segment;

  @override
  Widget build(BuildContext context) {
    final failed = segment.status == 'error';
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: failed ? const Color(0xfffff1f2) : AppColors.surfaceMuted,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: failed ? const Color(0xffffcdd2) : AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            segment.toolName ?? '工具调用',
            style: TextStyle(
              color: failed ? AppColors.danger : AppColors.ink,
              fontWeight: FontWeight.w800,
            ),
          ),
          if ((segment.summary ?? '').isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(segment.summary!, style: const TextStyle(color: AppColors.muted, fontSize: 12)),
          ],
          if ((segment.command ?? '').isNotEmpty) ...[
            const SizedBox(height: 8),
            SelectableText(segment.command!, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
          ],
          if ((segment.output ?? '').isNotEmpty) ...[
            const SizedBox(height: 8),
            SelectableText(segment.output!, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
          ],
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
      padding: const EdgeInsets.only(left: 10),
      decoration: const BoxDecoration(border: Border(left: BorderSide(color: AppColors.border, width: 2))),
      child: Text(
        segment.text ?? segment.title ?? '思考中',
        style: const TextStyle(color: AppColors.muted, fontSize: 13, height: 1.5),
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
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xfffff1f2),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xffffcdd2)),
      ),
      child: Text(
        segment.message ?? segment.text ?? '执行失败',
        style: const TextStyle(color: AppColors.danger, fontWeight: FontWeight.w700),
      ),
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
          color: isUser ? AppColors.primary : isError ? const Color(0xfffff1f2) : AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: isUser ? null : Border.all(color: isError ? const Color(0xffffcdd2) : AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Show accumulated streaming text (from delta events)
            if ((message.text ?? '').isNotEmpty)
              SelectableText(
                message.text!,
                style: TextStyle(
                  color: isUser ? Colors.white : isError ? AppColors.danger : AppColors.ink,
                  height: 1.5,
                ),
              ),
            // Show segments (status, tool, thought, etc.)
            if (message.segments.isNotEmpty)
              ...message.segments.map((segment) => Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: ChatSegmentView(segment: segment),
                  )),
            // Typing indicator for pending messages
            if (message.pending && (message.text ?? '').isEmpty && message.segments.isEmpty)
              const Text('处理中...', style: TextStyle(color: AppColors.muted, fontSize: 12))
            else if (message.pending && (message.text ?? '').isNotEmpty)
              const _TypingCursor(),
          ],
        ),
      ),
    );
  }
}

class _TypingCursor extends StatefulWidget {
  const _TypingCursor();

  @override
  State<_TypingCursor> createState() => _TypingCursorState();
}

class _TypingCursorState extends State<_TypingCursor>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 600))
      ..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (context, _) => Container(
        width: 2,
        height: 16,
        margin: const EdgeInsets.only(left: 2, top: 2),
        color: AppColors.primary.withValues(alpha: _ctrl.value),
      ),
    );
  }
}
