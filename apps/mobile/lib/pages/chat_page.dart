import 'package:flutter/material.dart';

import '../models/workbench_models.dart';
import '../state/workspace_controller.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import '../widgets/chat_segment_view.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.session});

  final AiSessionMeta session;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final _prompt = TextEditingController();
  final _scroll = ScrollController();
  String? _historyRequestedFor;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_historyRequestedFor != widget.session.id) {
      _historyRequestedFor = widget.session.id;
      WorkspaceScope.of(context).openSession(widget.session);
    }
  }

  @override
  void dispose() {
    _prompt.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    return AnimatedBuilder(
      animation: ws,
      builder: (context, _) {
        final session = ws.sessions.where((item) => item.id == widget.session.id).firstOrNull ??
            widget.session;
        final messages = ws.messagesBySession[session.id] ?? const <ChatMessage>[];
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
        });
        final title = ws.getEffectiveTitle(session);
        final runStatus = ws.runStatusBySession[session.id] ?? session.status;
        final isRunning = _isRunningStatus(runStatus) ||
            (messages.isNotEmpty &&
                messages.last.role == ChatRole.assistant &&
                messages.last.pending);
        return Scaffold(
          backgroundColor: AppColors.background,
          appBar: AppBar(
            titleSpacing: 0,
            title: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.ink,
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 3),
                      AppStatusBadge(
                        isRunning ? '运行中' : '空闲',
                        style: isRunning ? AppStatusStyle.warning : AppStatusStyle.neutral,
                        dot: true,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            actions: [
              PopupMenuButton<String>(
                tooltip: '更多',
                icon: const Icon(Icons.more_vert, size: 20),
                onSelected: (value) {
                  if (value == 'rename') {
                    _showRename(context, ws, session, title);
                  } else if (value == 'archive') {
                    ws.archiveSession(session, !session.archived);
                  }
                },
                itemBuilder: (ctx) => [
                  const PopupMenuItem(value: 'rename', child: Text('重命名会话')),
                  PopupMenuItem(
                    value: 'archive',
                    child: Text(session.archived ? '恢复会话' : '归档会话'),
                  ),
                ],
              ),
            ],
          ),
          body: Column(
            children: [
              if (session.archived)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md,
                    AppSpacing.md,
                    AppSpacing.md,
                    AppSpacing.xs,
                  ),
                  child: AppCard(
                    padding: const EdgeInsets.all(AppSpacing.md),
                    background: AppColors.dangerSoft,
                    borderColor: AppColors.danger,
                    shadow: const [],
                    child: Row(
                      children: [
                        const Icon(Icons.archive_outlined, size: 14, color: AppColors.danger),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(
                          child: Text(
                            '这个会话已归档。恢复后才能继续发送消息。',
                            style: const TextStyle(
                              color: AppColors.danger,
                              fontSize: 12,
                              height: 1.5,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              Expanded(
                child: ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.all(AppSpacing.md),
                  itemCount: messages.isEmpty ? 1 : messages.length,
                  itemBuilder: (_, index) => messages.isEmpty
                      ? const _SystemLine('桌面在线时会从本机 SQLite 拉取历史。')
                      : _MessageItem(message: messages[index]),
                ),
              ),
              SafeArea(
                top: false,
                child: Container(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md,
                    AppSpacing.sm,
                    AppSpacing.md,
                    AppSpacing.lg,
                  ),
                  decoration: const BoxDecoration(
                    color: AppColors.surface,
                    border: Border(top: BorderSide(color: AppColors.border)),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _prompt,
                          enabled: !session.archived,
                          minLines: 1,
                          maxLines: 5,
                          style: const TextStyle(fontSize: 14, height: 1.4),
                          decoration: const InputDecoration(
                            hintText: '输入消息...',
                            border: InputBorder.none,
                            fillColor: AppColors.surfaceMuted,
                          ),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      SizedBox(
                        width: 36,
                        height: 36,
                        child: FilledButton(
                          onPressed: !session.archived ? _send : null,
                          style: FilledButton.styleFrom(
                            padding: EdgeInsets.zero,
                            minimumSize: const Size(36, 36),
                            maximumSize: const Size(36, 36),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(AppRadius.lg),
                            ),
                          ),
                          child: const Icon(Icons.arrow_upward, size: 17, color: AppColors.inverse),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  bool _isRunningStatus(String status) {
    return status.contains('发送') ||
        status.contains('执行') ||
        status.contains('思考') ||
        status.contains('归档') ||
        status.contains('恢复');
  }

  void _send() {
    final text = _prompt.text;
    WorkspaceScope.of(context).sendPrompt(widget.session, text);
    _prompt.clear();
  }

  void _showRename(
    BuildContext context,
    WorkspaceController ws,
    AiSessionMeta session,
    String currentTitle,
  ) {
    final ctrl = TextEditingController(text: currentTitle);
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重命名会话'),
        content: TextField(controller: ctrl, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('取消')),
          FilledButton(
            onPressed: () {
              final trimmed = ctrl.text.trim();
              if (trimmed.isNotEmpty) ws.renameSession(session.id, trimmed);
              Navigator.of(ctx).pop();
            },
            child: const Text('确定'),
          ),
        ],
      ),
    );
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    for (final item in this) {
      return item;
    }
    return null;
  }
}

class _MessageItem extends StatelessWidget {
  const _MessageItem({required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    switch (message.role) {
      case ChatRole.user:
        return _UserBubble(message: message);
      case ChatRole.assistant:
        return _AiBubble(message: message);
      case ChatRole.system:
        return _SystemLine(message.text ?? '');
      case ChatRole.error:
        return _ErrorLine(message.text ?? '执行失败');
    }
  }
}

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 312),
        child: Container(
          margin: const EdgeInsets.only(bottom: AppSpacing.md),
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.md,
            vertical: 10,
          ),
          decoration: const BoxDecoration(
            color: AppColors.primary,
            borderRadius: BorderRadius.only(
              topLeft: Radius.circular(AppRadius.lg),
              topRight: Radius.circular(AppRadius.lg),
              bottomLeft: Radius.circular(AppRadius.lg),
              bottomRight: Radius.circular(AppRadius.sm),
            ),
            boxShadow: AppShadows.card,
          ),
          child: SelectableText(
            message.text ?? '',
            style: const TextStyle(
              color: AppColors.inverse,
              fontSize: 13,
              fontWeight: FontWeight.w400,
              height: 1.55,
            ),
          ),
        ),
      ),
    );
  }
}

class _AiBubble extends StatelessWidget {
  const _AiBubble({required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    final finalText = _finalContentText(message);
    final isThinking = message.pending && finalText.isEmpty && message.segments.isEmpty;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppIconBox(
            icon: Icons.smart_toy_outlined,
            size: 24,
            iconSize: 14,
            background: AppColors.primarySoftSolid,
            foreground: AppColors.primary,
            borderRadius: AppRadius.lg,
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'AI 工作台',
                  style: TextStyle(
                    color: AppColors.secondary,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                AppCard(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ChatProcessPanel(segments: message.segments, pending: message.pending),
                      ChatFinalContent(text: finalText, pending: isThinking),
                    ],
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

class _SystemLine extends StatelessWidget {
  const _SystemLine(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      alignment: Alignment.center,
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: const TextStyle(
          color: AppColors.muted,
          fontSize: 12,
          height: 1.5,
        ),
      ),
    );
  }
}

class _ErrorLine extends StatelessWidget {
  const _ErrorLine(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      alignment: Alignment.center,
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: const TextStyle(
          color: AppColors.danger,
          fontSize: 12,
          height: 1.5,
        ),
      ),
    );
  }
}