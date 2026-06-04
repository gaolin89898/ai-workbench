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
        final session = ws.sessions.where((item) => item.id == widget.session.id).firstOrNull ?? widget.session;
        final messages = ws.messagesBySession[session.id] ?? const <ChatMessage>[];
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
        });
        final title = ws.getEffectiveTitle(session);
        return Scaffold(
          appBar: AppBar(
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, overflow: TextOverflow.ellipsis),
                Text(
                  '${session.providerId} · ${ws.runStatusBySession[session.id] ?? session.status}',
                  style: const TextStyle(color: AppColors.muted, fontSize: 12, fontWeight: FontWeight.w600),
                ),
              ],
            ),
            actions: [
              IconButton(
                tooltip: '重命名',
                onPressed: () => _showRename(context, ws, session, title),
                icon: const Icon(Icons.edit_outlined, size: 20),
              ),
              IconButton(
                tooltip: session.archived ? '恢复' : '归档',
                onPressed: () => ws.archiveSession(session, !session.archived),
                icon: Icon(session.archived ? Icons.unarchive_outlined : Icons.archive_outlined),
              ),
            ],
          ),
          body: Column(
            children: [
              if (session.archived)
                const Padding(
                  padding: EdgeInsets.all(12),
                  child: AppCard(child: Text('这个会话已归档。恢复后才能继续发送消息。')),
                ),
              Expanded(
                child: ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.fromLTRB(14, 14, 14, 18),
                  itemCount: messages.isEmpty ? 1 : messages.length,
                  itemBuilder: (_, index) => messages.isEmpty
                      ? const ChatBubble(message: ChatMessage(role: ChatRole.system, text: '桌面在线时会从本机 SQLite 拉取历史。'))
                      : ChatBubble(message: messages[index]),
                ),
              ),
              SafeArea(
                top: false,
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: const BoxDecoration(
                    color: AppColors.surface,
                    border: Border(top: BorderSide(color: AppColors.border)),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _prompt,
                          enabled: !session.archived,
                          minLines: 1,
                          maxLines: 5,
                          decoration: InputDecoration(hintText: '发送给 ${session.providerId}'),
                        ),
                      ),
                      const SizedBox(width: 10),
                      SizedBox(
                        width: 48,
                        height: 48,
                        child: FilledButton(
                          onPressed: !session.archived ? _send : null,
                          style: FilledButton.styleFrom(padding: EdgeInsets.zero),
                          child: const Icon(Icons.arrow_upward),
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

  void _send() {
    final text = _prompt.text;
    WorkspaceScope.of(context).sendPrompt(widget.session, text);
    _prompt.clear();
  }

  void _showRename(BuildContext context, WorkspaceController ws, AiSessionMeta session, String currentTitle) {
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
