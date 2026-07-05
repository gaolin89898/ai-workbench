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
  static const _autoScrollBottomThreshold = 96.0;
  final _prompt = TextEditingController();
  final _scroll = ScrollController();
  String? _historyRequestedFor;
  WorkspaceController? _workspace;

  bool get _isNearBottom {
    if (!_scroll.hasClients) return true;
    final position = _scroll.position;
    return position.maxScrollExtent - position.pixels <=
        _autoScrollBottomThreshold;
  }

  void _scrollToBottom() {
    if (!_scroll.hasClients) return;
    _scroll.jumpTo(_scroll.position.maxScrollExtent);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _workspace = WorkspaceScope.of(context);
    if (_historyRequestedFor != widget.session.id) {
      _historyRequestedFor = widget.session.id;
      _workspace?.openSession(widget.session);
    }
  }

  @override
  void dispose() {
    _workspace?.closeSession(widget.session);
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
        final matchedSession = ws.sessions
            .where((item) => item.id == widget.session.id)
            .firstOrNull;
        if (matchedSession == null && !ws.loading) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (context.mounted) Navigator.of(context).maybePop();
          });
          return const Scaffold(
            backgroundColor: AppColors.background,
            body: Center(
              child: Text(
                '会话已不再可用',
                style: TextStyle(color: AppColors.muted, fontSize: 13),
              ),
            ),
          );
        }
        final session = matchedSession ?? widget.session;
        final messages =
            ws.messagesBySession[session.id] ?? const <ChatMessage>[];
        final title = ws.getEffectiveTitle(session);
        final runStatus = ws.runStatusBySession[session.id] ?? session.status;
        final isRunning = _isRunningStatus(runStatus) ||
            (messages.isNotEmpty &&
                messages.last.role == ChatRole.assistant &&
                messages.last.pending);
        final pendingApproval = _findPendingApproval(messages);
        final shouldStickToBottom = _isNearBottom;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (shouldStickToBottom) _scrollToBottom();
        });
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
                        style: isRunning
                            ? AppStatusStyle.warning
                            : AppStatusStyle.neutral,
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
                        const Icon(Icons.archive_outlined,
                            size: 14, color: AppColors.danger),
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
                      : _MessageItem(
                          message: messages[index],
                          onApproval: (segment, decision) {
                            final approvalId = segment.approvalId;
                            if (approvalId == null || approvalId.isEmpty) {
                              return;
                            }
                            ws.respondApproval(session, approvalId, decision);
                          },
                        ),
                ),
              ),
              _ChatComposer(
                controller: _prompt,
                archived: session.archived,
                pendingApproval: pendingApproval,
                onSend: _send,
                onApproval: (segment, decision) {
                  final approvalId = segment.approvalId;
                  if (approvalId == null || approvalId.isEmpty) return;
                  ws.respondApproval(session, approvalId, decision);
                },
              ),
            ],
          ),
        );
      },
    );
  }

  ChatSegment? _findPendingApproval(List<ChatMessage> messages) {
    for (final message in messages.reversed) {
      for (final segment in message.segments.reversed) {
        if (segment.type == 'approval' && segment.status == 'pending') {
          return segment;
        }
      }
    }
    return null;
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
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('取消')),
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

class _ChatComposer extends StatelessWidget {
  const _ChatComposer({
    required this.controller,
    required this.archived,
    required this.pendingApproval,
    required this.onSend,
    required this.onApproval,
  });

  final TextEditingController controller;
  final bool archived;
  final ChatSegment? pendingApproval;
  final VoidCallback onSend;
  final void Function(ChatSegment segment, String decision) onApproval;

  @override
  Widget build(BuildContext context) {
    final approval = pendingApproval;
    return SafeArea(
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
        child: approval == null
            ? _ComposerInput(
                controller: controller,
                archived: archived,
                onSend: onSend,
              )
            : Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const _LockedComposerHint(),
                  const SizedBox(height: AppSpacing.sm),
                  _ApprovalCoverCard(
                    segment: approval,
                    onApproval: onApproval,
                  ),
                ],
              ),
      ),
    );
  }
}

class _ComposerInput extends StatelessWidget {
  const _ComposerInput({
    required this.controller,
    required this.archived,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool archived;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: TextField(
            controller: controller,
            enabled: !archived,
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
            onPressed: !archived ? onSend : null,
            style: FilledButton.styleFrom(
              padding: EdgeInsets.zero,
              minimumSize: const Size(36, 36),
              maximumSize: const Size(36, 36),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(AppRadius.lg),
              ),
            ),
            child: const Icon(Icons.arrow_upward,
                size: 17, color: AppColors.inverse),
          ),
        ),
      ],
    );
  }
}

class _LockedComposerHint extends StatelessWidget {
  const _LockedComposerHint();

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 44,
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surfaceMuted,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(AppRadius.lg),
      ),
      child: Row(
        children: const [
          Icon(Icons.lock_outline, size: 16, color: AppColors.muted),
          SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              '等待你处理审批后继续输入',
              style: TextStyle(color: AppColors.muted, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}

class _ApprovalCoverCard extends StatelessWidget {
  const _ApprovalCoverCard({required this.segment, required this.onApproval});

  final ChatSegment segment;
  final void Function(ChatSegment segment, String decision) onApproval;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    final command = segment.command?.trim();
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.warning.withValues(alpha: 0.24)),
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadows.card,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(height: 3, color: AppColors.warning),
            Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      AppIconBox(
                        icon: Icons.verified_user_outlined,
                        size: 34,
                        iconSize: 18,
                        background: AppColors.warningSoft,
                        foreground: AppColors.warning,
                        borderRadius: AppRadius.lg,
                      ),
                      const SizedBox(width: AppSpacing.md),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: const [
                                AppStatusBadge(
                                  '待审批',
                                  style: AppStatusStyle.warning,
                                  dot: true,
                                ),
                                SizedBox(width: AppSpacing.sm),
                                Expanded(
                                  child: Text(
                                    '输入框已锁定',
                                    style: TextStyle(
                                      color: AppColors.muted,
                                      fontSize: 12,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 6),
                            Text(
                              segment.title ?? '需要确认 AI 工具操作',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.titleSmall?.copyWith(
                                color: AppColors.ink,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              _approvalKindLabel(segment),
                              style: theme.bodySmall?.copyWith(
                                color: AppColors.secondary,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.md),
                  Text(
                    segment.reason?.isNotEmpty == true
                        ? segment.reason!
                        : 'AI 工具准备执行可能影响项目的操作，请确认是否允许本次操作。',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.bodySmall?.copyWith(
                      color: AppColors.secondary,
                      height: 1.5,
                    ),
                  ),
                  if (command != null && command.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.md),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(AppSpacing.sm),
                      decoration: BoxDecoration(
                        color: AppColors.surfaceMuted,
                        borderRadius: BorderRadius.circular(AppRadius.md),
                      ),
                      child: Text(
                        command,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.ink,
                          fontSize: 12,
                          fontFamily: 'monospace',
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: AppSpacing.md),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => onApproval(segment, 'denied'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppColors.ink,
                            side: const BorderSide(color: AppColors.border),
                            minimumSize: const Size(0, 42),
                          ),
                          child: const Text('拒绝'),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: FilledButton(
                          onPressed: () => onApproval(segment, 'approved'),
                          style: FilledButton.styleFrom(
                            minimumSize: const Size(0, 42),
                          ),
                          child: const Text('允许执行'),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _approvalKindLabel(ChatSegment segment) {
    if (segment.approvalKind == 'fileChange') return '文件修改 · 本次会话';
    if (segment.approvalKind == 'command') return '命令执行 · 本次会话';
    return '工具操作 · 本次会话';
  }
}

class _MessageItem extends StatelessWidget {
  const _MessageItem({required this.message, this.onApproval});

  final ChatMessage message;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
    switch (message.role) {
      case ChatRole.user:
        return _UserBubble(message: message);
      case ChatRole.assistant:
        return _AiBubble(message: message, onApproval: onApproval);
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
  const _AiBubble({required this.message, this.onApproval});

  final ChatMessage message;
  final void Function(ChatSegment segment, String decision)? onApproval;

  @override
  Widget build(BuildContext context) {
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
                  child: ChatMessageContent(
                      message: message, onApproval: onApproval),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
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
