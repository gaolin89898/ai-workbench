import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../models/workbench_models.dart';
import '../state/workspace_controller.dart';
import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';
import '../widgets/chat_segment_view.dart';
import 'project_files_page.dart';

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
  final List<ChatContextAttachment> _contexts = [];
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
        final project = ws.projects.where((item) {
          return item.id == session.projectId || item.path == session.summary;
        }).firstOrNull;
        final messages =
            ws.messagesBySession[session.id] ?? const <ChatMessage>[];
        final title = ws.getEffectiveTitle(session);
        final runStatus = ws.runStatusBySession[session.id] ?? session.status;
        final isRunning = _isRunningStatus(runStatus) ||
            (messages.isNotEmpty &&
                messages.last.role == ChatRole.assistant &&
                messages.last.pending);
        final pendingApproval =
            isRunning ? _findPendingApproval(messages) : null;
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
              if (project != null)
                IconButton(
                  tooltip: '项目文件',
                  icon: const Icon(Icons.folder_open_outlined, size: 20),
                  onPressed: () => _openProjectFiles(context, ws, project),
                ),
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
                  scrollCacheExtent: const ScrollCacheExtent.pixels(900),
                  addAutomaticKeepAlives: false,
                  addRepaintBoundaries: false,
                  itemCount: messages.isEmpty ? 1 : messages.length,
                  itemBuilder: (_, index) => messages.isEmpty
                      ? const _SystemLine('这个会话还没有聊天记录。')
                      : RepaintBoundary(
                          key: ValueKey(_messageRenderKey(
                            messages[index],
                            index,
                          )),
                          child: _MessageItem(
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
              ),
              _ChatComposer(
                controller: _prompt,
                archived: session.archived,
                providerId: session.providerId,
                runSettings:
                    ws.selectedRunSettings?.forProvider(session.providerId),
                isRunning: isRunning,
                pendingApproval: pendingApproval,
                contexts: _contexts,
                onSend: _send,
                onStop: () => _stop(session),
                onOpenProjectFiles: project == null
                    ? null
                    : () => _openProjectFiles(context, ws, project),
                onRemoveContext: (id) {
                  setState(() => _contexts.removeWhere((item) => item.id == id));
                },
                onRunSettingsChanged: (model, reasoningEffort) {
                  ws.updateRunSettings(
                    session.providerId,
                    model: model,
                    reasoningEffort: reasoningEffort,
                  );
                },
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

  String _messageRenderKey(ChatMessage message, int index) {
    final textHash = message.text?.hashCode ?? 0;
    return '$index:${message.role.name}:${message.pending}:$textHash:'
        '${message.segments.length}:${message.contexts.length}';
  }

  bool _isRunningStatus(String status) {
    return status.contains('发送') ||
        status.contains('执行') ||
        status.contains('思考') ||
        status.contains('归档') ||
        status.contains('恢复');
  }

  void _send({
    String? model,
    String? reasoningEffort,
    String? mode,
    String? goal,
  }) {
    final text = _prompt.text;
    WorkspaceScope.of(context).sendPrompt(
      widget.session,
      text,
      model: model,
      reasoningEffort: reasoningEffort,
      mode: mode,
      goal: goal,
      contexts: List<ChatContextAttachment>.from(_contexts),
    );
    _prompt.clear();
    setState(() => _contexts.clear());
  }

  void _stop(AiSessionMeta session) {
    WorkspaceScope.of(context).stopPrompt(session);
  }

  Future<void> _openProjectFiles(
    BuildContext context,
    WorkspaceController workspace,
    WorkspaceProject project,
  ) async {
    final selected = await Navigator.of(context).push<ChatContextAttachment>(
      MaterialPageRoute(
        builder: (_) => WorkspaceScope(
          controller: workspace,
          child: ProjectFilesPage(project: project, selectContext: true),
        ),
      ),
    );
    if (!mounted || selected == null) return;
    final duplicate = _contexts.any((item) {
      if (item.kind != selected.kind) return false;
      if (item.isPath) return item.path == selected.path;
      return item.path == selected.path &&
          item.startLine == selected.startLine &&
          item.endLine == selected.endLine &&
          item.content == selected.content;
    });
    if (!duplicate) setState(() => _contexts.add(selected));
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
    required this.providerId,
    required this.runSettings,
    required this.isRunning,
    required this.pendingApproval,
    required this.contexts,
    required this.onSend,
    required this.onStop,
    required this.onOpenProjectFiles,
    required this.onRemoveContext,
    required this.onRunSettingsChanged,
    required this.onApproval,
  });

  final TextEditingController controller;
  final bool archived;
  final String providerId;
  final AiRunProviderSettings? runSettings;
  final bool isRunning;
  final ChatSegment? pendingApproval;
  final List<ChatContextAttachment> contexts;
  final void Function({
    String? model,
    String? reasoningEffort,
    String? mode,
    String? goal,
  }) onSend;
  final VoidCallback onStop;
  final VoidCallback? onOpenProjectFiles;
  final ValueChanged<String> onRemoveContext;
  final void Function(String? model, String? reasoningEffort)
      onRunSettingsChanged;
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
                providerId: providerId,
                runSettings: runSettings,
                isRunning: isRunning,
                contexts: contexts,
                onSend: onSend,
                onStop: onStop,
                onOpenProjectFiles: onOpenProjectFiles,
                onRemoveContext: onRemoveContext,
                onRunSettingsChanged: onRunSettingsChanged,
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

class _ComposerInput extends StatefulWidget {
  const _ComposerInput({
    required this.controller,
    required this.archived,
    required this.providerId,
    required this.runSettings,
    required this.isRunning,
    required this.contexts,
    required this.onSend,
    required this.onStop,
    required this.onOpenProjectFiles,
    required this.onRemoveContext,
    required this.onRunSettingsChanged,
  });

  final TextEditingController controller;
  final bool archived;
  final String providerId;
  final AiRunProviderSettings? runSettings;
  final bool isRunning;
  final List<ChatContextAttachment> contexts;
  final void Function({
    String? model,
    String? reasoningEffort,
    String? mode,
    String? goal,
  }) onSend;
  final VoidCallback onStop;
  final VoidCallback? onOpenProjectFiles;
  final ValueChanged<String> onRemoveContext;
  final void Function(String? model, String? reasoningEffort)
      onRunSettingsChanged;

  @override
  State<_ComposerInput> createState() => _ComposerInputState();
}

class _ComposerInputState extends State<_ComposerInput> {
  String _selectedModel = '';
  String _selectedReasoning = 'high';
  String _selectedMode = 'default';
  String _goal = '';

  @override
  void initState() {
    super.initState();
    _syncFromRunSettings();
  }

  @override
  void didUpdateWidget(covariant _ComposerInput oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.providerId != widget.providerId ||
        oldWidget.runSettings != widget.runSettings) {
      _syncFromRunSettings();
    }
  }

  void _syncFromRunSettings() {
    final settings = widget.runSettings;
    final models = settings?.models ?? const <AiRunModelOption>[];
    _selectedModel = settings?.model.isNotEmpty == true
        ? settings!.model
        : models.firstOrNull?.model ?? '';
    _selectedReasoning = settings?.reasoningEffort.isNotEmpty == true
        ? settings!.reasoningEffort
        : 'high';
  }

  List<_SheetOption> get _modelOptions {
    final syncedModels = widget.runSettings?.models ?? const <AiRunModelOption>[];
    if (syncedModels.isEmpty) {
      return const [
        _SheetOption('', '桌面端默认模型', '等待桌面端同步模型列表'),
      ];
    }
    return [
      for (final model in syncedModels)
        _SheetOption(
          model.model,
          model.displayName,
          model.description ?? model.model,
        ),
    ];
  }

  List<_SheetOption> get _reasoningOptions {
    final syncedOptions =
        widget.runSettings?.reasoningOptions ?? const <String>[];
    final source = syncedOptions.isEmpty ? const ['high'] : syncedOptions;
    return [
      for (final option in source)
        _SheetOption(option, _reasoningLabel(option), ''),
    ];
  }

  String _reasoningLabel(String value) => switch (value) {
        'low' => '低',
        'medium' => '中',
        'high' => '高',
        'ultra' => '超高',
        'xhigh' => '超高',
        'max' => '最大',
        _ => value,
      };

  String get _selectedModelLabel =>
      _modelOptions.where((option) => option.value == _selectedModel).firstOrNull?.label ??
      _modelOptions.first.label;

  String get _selectedReasoningLabel =>
      _reasoningOptions.where((option) => option.value == _selectedReasoning).firstOrNull?.label ??
      _reasoningOptions.first.label;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (widget.contexts.isNotEmpty) ...[
          Align(
            alignment: Alignment.centerLeft,
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final context in widget.contexts)
                  _ContextChip(
                    context: context,
                    onDeleted: () => widget.onRemoveContext(context.id),
                  ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
        ],
        Container(
          decoration: BoxDecoration(
            color: AppColors.surfaceMuted,
            border: Border.all(
              color: widget.archived ? AppColors.border : AppColors.borderActive,
              width: widget.archived ? 1 : 2,
            ),
            borderRadius: BorderRadius.circular(AppRadius.lg),
          ),
          clipBehavior: Clip.antiAlias,
          child: TextField(
            controller: widget.controller,
            enabled: !widget.archived,
            minLines: 1,
            maxLines: 5,
            textInputAction: TextInputAction.newline,
            style: const TextStyle(
              fontSize: 14,
              height: 1.5,
              color: AppColors.ink,
            ),
            decoration: const InputDecoration(
              hintText: '输入你的消息...',
              isDense: true,
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              disabledBorder: InputBorder.none,
              contentPadding: EdgeInsets.symmetric(
                horizontal: 14,
                vertical: 12,
              ),
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        Row(
          children: [
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    if (widget.onOpenProjectFiles != null) ...[
                      _ComposerIconButton(
                        icon: Icons.add_link_rounded,
                        tooltip: '添加项目上下文',
                        onPressed: widget.archived
                            ? null
                            : widget.onOpenProjectFiles,
                      ),
                      const SizedBox(width: 6),
                    ],
                    _ComposerIconButton(
                      icon: _goal.isEmpty
                          ? Icons.tune_outlined
                          : Icons.flag_outlined,
                      tooltip: '任务设置',
                      onPressed: widget.archived ? null : _showAddSheet,
                    ),
                    const SizedBox(width: 6),
                    _ComposerPillButton(
                      label: _selectedMode == 'plan' ? '规划' : '构建',
                      maxWidth: 72,
                      onPressed: widget.archived ? null : _showModeSheet,
                    ),
                    const SizedBox(width: 6),
                    _ComposerPillButton(
                      label: _selectedModelLabel,
                      maxWidth: 122,
                      onPressed: widget.archived ? null : _showModelSheet,
                    ),
                    const SizedBox(width: 6),
                    _ComposerPillButton(
                      label: '推理 $_selectedReasoningLabel',
                      maxWidth: 94,
                      onPressed: widget.archived ? null : _showReasoningSheet,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            ValueListenableBuilder<TextEditingValue>(
              valueListenable: widget.controller,
              builder: (context, value, _) {
                final canSend = !widget.archived &&
                    (widget.isRunning ||
                        value.text.trim().isNotEmpty ||
                        widget.contexts.isNotEmpty);
                return _ComposerSendButton(
                  enabled: canSend,
                  isRunning: widget.isRunning,
                  onPressed: widget.isRunning
                      ? widget.onStop
                      : () => widget.onSend(
                            model: _selectedModel,
                            reasoningEffort: _selectedReasoning,
                            mode: _selectedMode,
                            goal: _goal.trim().isEmpty ? null : _goal.trim(),
                          ),
                );
              },
            ),
          ],
        ),
      ],
    );
  }

  void _showAddSheet() {
    _showComposerSheet(
      context: context,
      title: '任务设置',
      subtitle: _goal.isEmpty ? '设置运行方式和本轮目标' : '当前目标：$_goal',
      children: [
        _SheetActionTile(
          icon: Icons.account_tree_outlined,
          title: _selectedMode == 'plan' ? '当前：规划模式' : '当前：构建模式',
          subtitle: _selectedMode == 'plan' ? '点击切换到构建模式' : '点击切换到规划模式',
          onTap: () {
            setState(() {
              _selectedMode = _selectedMode == 'plan' ? 'default' : 'plan';
            });
            Navigator.of(context).pop();
          },
        ),
        _SheetActionTile(
          icon: Icons.flag_outlined,
          title: _goal.isEmpty ? '设置本轮目标' : '编辑本轮目标',
          subtitle: _goal.isEmpty ? '为后续消息附加持续目标' : _goal,
          onTap: () {
            Navigator.of(context).pop();
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) _showGoalDialog();
            });
          },
        ),
        if (_goal.isNotEmpty)
          _SheetActionTile(
            icon: Icons.flag_circle_outlined,
            title: '清除本轮目标',
            subtitle: '后续消息不再附加目标',
            onTap: () {
              setState(() => _goal = '');
              Navigator.of(context).pop();
            },
          ),
      ],
    );
  }

  void _showModeSheet() {
    _showComposerSheet(
      context: context,
      title: '运行模式',
      subtitle: '构建模式可执行修改，规划模式优先分析和制定方案',
      children: [
        _SheetOptionTile(
          option: const _SheetOption('default', '构建', '执行代码修改和命令'),
          selected: _selectedMode == 'default',
          onTap: () {
            setState(() => _selectedMode = 'default');
            Navigator.of(context).pop();
          },
        ),
        _SheetOptionTile(
          option: const _SheetOption('plan', '规划', '只分析任务并制定实施方案'),
          selected: _selectedMode == 'plan',
          onTap: () {
            setState(() => _selectedMode = 'plan');
            Navigator.of(context).pop();
          },
        ),
      ],
    );
  }

  Future<void> _showGoalDialog() async {
    final controller = TextEditingController(text: _goal);
    final result = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('本轮目标'),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 2,
          maxLines: 4,
          decoration: const InputDecoration(
            hintText: '例如：完成移动端功能对齐并通过测试',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.of(dialogContext).pop(controller.text.trim()),
            child: const Text('确定'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (result != null && mounted) setState(() => _goal = result);
  }

  void _showModelSheet() {
    _showComposerSheet(
      context: context,
      title: '模型选择',
      subtitle: '选择本次输入区使用的模型',
      children: [
        for (final option in _modelOptions)
          _SheetOptionTile(
            option: option,
            selected: option.value == _selectedModel,
            onTap: () {
              setState(() => _selectedModel = option.value);
              widget.onRunSettingsChanged(_selectedModel, _selectedReasoning);
              Navigator.of(context).pop();
            },
          ),
      ],
    );
  }

  void _showReasoningSheet() {
    _showComposerSheet(
      context: context,
      title: '推理强度',
      subtitle: '更高强度通常更慢，但适合复杂任务',
      children: [
        for (final option in _reasoningOptions)
          _SheetOptionTile(
            option: option,
            selected: option.value == _selectedReasoning,
            onTap: () {
              setState(() => _selectedReasoning = option.value);
              widget.onRunSettingsChanged(_selectedModel, _selectedReasoning);
              Navigator.of(context).pop();
            },
          ),
      ],
    );
  }
}

class _SheetOption {
  const _SheetOption(this.value, this.label, this.description);

  final String value;
  final String label;
  final String description;
}

Future<void> _showComposerSheet({
  required BuildContext context,
  required String title,
  required String subtitle,
  required List<Widget> children,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    builder: (context) {
      final height = MediaQuery.sizeOf(context).height * 0.52;
      return Align(
        alignment: Alignment.bottomCenter,
        child: Container(
          height: height,
          decoration: const BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.vertical(
              top: Radius.circular(AppRadius.xl),
            ),
          ),
          child: Column(
            children: [
              const SizedBox(height: AppSpacing.sm),
              Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: AppColors.border,
                  borderRadius: BorderRadius.circular(AppRadius.full),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.lg,
                  AppSpacing.md,
                  AppSpacing.lg,
                  AppSpacing.sm,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            style: const TextStyle(
                              color: AppColors.ink,
                              fontSize: 17,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            subtitle,
                            style: const TextStyle(
                              color: AppColors.muted,
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: '关闭',
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close, size: 20),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1, color: AppColors.border),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md,
                    AppSpacing.md,
                    AppSpacing.md,
                    AppSpacing.lg,
                  ),
                  children: children,
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

class _SheetOptionTile extends StatelessWidget {
  const _SheetOptionTile({
    required this.option,
    required this.selected,
    required this.onTap,
  });

  final _SheetOption option;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return _SheetTileShell(
      enabled: true,
      onTap: onTap,
      leading: Icon(
        selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
        size: 20,
        color: selected ? AppColors.primary : AppColors.muted,
      ),
      title: option.label,
      subtitle: option.description,
      trailing: selected
          ? const Icon(Icons.check, size: 18, color: AppColors.primary)
          : null,
    );
  }
}

class _SheetActionTile extends StatelessWidget {
  const _SheetActionTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.enabled = true,
    this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final bool enabled;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return _SheetTileShell(
      enabled: enabled,
      onTap: onTap,
      leading: Icon(
        icon,
        size: 20,
        color: enabled ? AppColors.primary : AppColors.muted,
      ),
      title: title,
      subtitle: subtitle,
    );
  }
}

class _SheetTileShell extends StatelessWidget {
  const _SheetTileShell({
    required this.enabled,
    required this.leading,
    required this.title,
    required this.subtitle,
    this.trailing,
    this.onTap,
  });

  final bool enabled;
  final Widget leading;
  final String title;
  final String subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Material(
        color: enabled ? AppColors.surfaceMuted : AppColors.surfaceMuted.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(AppRadius.lg),
        child: InkWell(
          onTap: enabled ? onTap : null,
          borderRadius: BorderRadius.circular(AppRadius.lg),
          child: Container(
            constraints: const BoxConstraints(minHeight: 64),
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.md,
              vertical: AppSpacing.sm,
            ),
            child: Row(
              children: [
                SizedBox(width: 28, child: Center(child: leading)),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: enabled ? AppColors.ink : AppColors.muted,
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        subtitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.muted,
                          fontSize: 12,
                          height: 1.35,
                        ),
                      ),
                    ],
                  ),
                ),
                if (trailing != null) ...[
                  const SizedBox(width: AppSpacing.sm),
                  trailing!,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ContextChip extends StatelessWidget {
  const _ContextChip({required this.context, required this.onDeleted});

  final ChatContextAttachment context;
  final VoidCallback onDeleted;

  @override
  Widget build(BuildContext context) {
    final icon = switch (this.context.kind) {
      'folder' => Icons.folder_outlined,
      'code' => Icons.code_rounded,
      'terminal' => Icons.terminal_rounded,
      _ => Icons.insert_drive_file_outlined,
    };
    return Tooltip(
      message: this.context.path ?? this.context.name,
      child: InputChip(
        avatar: Icon(icon, size: 16, color: AppColors.primary),
        label: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 148),
          child: Text(
            this.context.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        onDeleted: onDeleted,
        deleteIcon: const Icon(Icons.close_rounded, size: 16),
        visualDensity: VisualDensity.compact,
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        side: const BorderSide(color: AppColors.border),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.sm),
        ),
        backgroundColor: AppColors.surfaceMuted,
        labelStyle: const TextStyle(
          color: AppColors.ink,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _ComposerIconButton extends StatelessWidget {
  const _ComposerIconButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 32,
      height: 32,
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        style: IconButton.styleFrom(
          padding: EdgeInsets.zero,
          backgroundColor: Colors.transparent,
          disabledBackgroundColor: Colors.transparent,
          foregroundColor: AppColors.secondary,
          disabledForegroundColor: AppColors.muted,
          side: const BorderSide(color: AppColors.border),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.lg),
          ),
        ),
        icon: Icon(icon, size: 16),
      ),
    );
  }
}

class _ComposerPillButton extends StatelessWidget {
  const _ComposerPillButton({
    required this.label,
    required this.onPressed,
    this.maxWidth,
  });

  final String label;
  final VoidCallback? onPressed;
  final double? maxWidth;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: BoxConstraints(
        minHeight: 32,
        maxWidth: maxWidth ?? double.infinity,
      ),
      child: OutlinedButton(
        onPressed: onPressed,
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 32),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          foregroundColor: AppColors.secondary,
          disabledForegroundColor: AppColors.muted,
          backgroundColor: Colors.transparent,
          side: const BorderSide(color: AppColors.border),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.full),
          ),
          textStyle: const TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w700,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 4),
            const Icon(Icons.keyboard_arrow_down, size: 14),
          ],
        ),
      ),
    );
  }
}

class _ComposerSendButton extends StatelessWidget {
  const _ComposerSendButton({
    required this.enabled,
    required this.isRunning,
    required this.onPressed,
  });

  final bool enabled;
  final bool isRunning;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 36,
      height: 36,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadius.full),
        boxShadow: enabled
            ? [
                BoxShadow(
                  color: AppColors.primary.withValues(alpha: 0.30),
                  blurRadius: 8,
                  offset: const Offset(0, 2),
                ),
              ]
            : null,
      ),
      child: FilledButton(
        onPressed: enabled ? onPressed : null,
        style: FilledButton.styleFrom(
          padding: EdgeInsets.zero,
          minimumSize: const Size(36, 36),
          maximumSize: const Size(36, 36),
          disabledBackgroundColor: AppColors.surfaceMuted,
          disabledForegroundColor: AppColors.muted,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.full),
          ),
        ),
        child: Icon(
          isRunning ? Icons.stop_rounded : Icons.arrow_upward,
          size: 18,
          color: enabled ? AppColors.inverse : AppColors.muted,
        ),
      ),
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
    final provider = segment.providerId == 'mimo' ? 'MiMo Code' : 'Codex';
    if (segment.approvalKind == 'fileChange') return '$provider · 文件修改 · 本次会话';
    if (segment.approvalKind == 'command') return '$provider · 命令执行 · 本次会话';
    return '$provider · 工具操作 · 本次会话';
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
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if ((message.text ?? '').trim().isNotEmpty)
                SelectableText(
                  message.text!,
                  style: const TextStyle(
                    color: AppColors.inverse,
                    fontSize: 13,
                    fontWeight: FontWeight.w400,
                    height: 1.55,
                  ),
                ),
              if ((message.text ?? '').trim().isNotEmpty &&
                  message.contexts.isNotEmpty)
                const SizedBox(height: 8),
              if (message.contexts.isNotEmpty)
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final context in message.contexts)
                      Container(
                        constraints: const BoxConstraints(maxWidth: 220),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 5,
                        ),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(AppRadius.sm),
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.24),
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              context.kind == 'folder'
                                  ? Icons.folder_outlined
                                  : context.kind == 'code'
                                      ? Icons.code_rounded
                                      : Icons.insert_drive_file_outlined,
                              size: 14,
                              color: AppColors.inverse,
                            ),
                            const SizedBox(width: 5),
                            Flexible(
                              child: Text(
                                context.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  color: AppColors.inverse,
                                  fontSize: 10,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
            ],
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
                  'CodeHub AI',
                  style: TextStyle(
                    color: AppColors.secondary,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Padding(
                  padding: const EdgeInsets.only(top: 2),
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
