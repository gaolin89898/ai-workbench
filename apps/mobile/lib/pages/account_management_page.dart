import 'package:flutter/material.dart';

import '../state/workspace_scope.dart';
import '../widgets/app_theme.dart';

class AccountAvatarOption {
  const AccountAvatarOption({
    required this.icon,
    required this.background,
    required this.foreground,
  });

  final IconData icon;
  final Color background;
  final Color foreground;
}

const accountAvatarOptions = <AccountAvatarOption>[
  AccountAvatarOption(
    icon: Icons.person,
    background: AppColors.primary,
    foreground: AppColors.inverse,
  ),
  AccountAvatarOption(
    icon: Icons.smart_toy_outlined,
    background: AppColors.infoSoft,
    foreground: AppColors.info,
  ),
  AccountAvatarOption(
    icon: Icons.terminal_outlined,
    background: AppColors.surfaceMuted,
    foreground: AppColors.secondary,
  ),
  AccountAvatarOption(
    icon: Icons.auto_fix_high_outlined,
    background: AppColors.warningSoft,
    foreground: AppColors.warningDeep,
  ),
  AccountAvatarOption(
    icon: Icons.shield_outlined,
    background: AppColors.successSoft,
    foreground: AppColors.successDeep,
  ),
  AccountAvatarOption(
    icon: Icons.code,
    background: AppColors.dangerSoft,
    foreground: AppColors.dangerDeep,
  ),
];

class AccountAvatar extends StatelessWidget {
  const AccountAvatar({
    super.key,
    required this.index,
    this.size = 48,
    this.iconSize = 24,
    this.selected = false,
  });

  final int index;
  final double size;
  final double iconSize;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final option = accountAvatarOptions[
        index.clamp(0, accountAvatarOptions.length - 1).toInt()];
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: option.background,
        borderRadius: BorderRadius.circular(size * 0.35),
        border: selected
            ? Border.all(color: AppColors.primary, width: 2)
            : Border.all(color: Colors.transparent, width: 2),
      ),
      child: Icon(option.icon, size: iconSize, color: option.foreground),
    );
  }
}

class AccountManagementPage extends StatefulWidget {
  const AccountManagementPage({super.key});

  @override
  State<AccountManagementPage> createState() => _AccountManagementPageState();
}

class _AccountManagementPageState extends State<AccountManagementPage> {
  final TextEditingController _nameController = TextEditingController();
  bool _initialized = false;
  int _avatarIndex = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_initialized) return;
    _initialized = true;
    final ws = WorkspaceScope.of(context);
    _nameController.text = ws.accountDisplayName;
    _avatarIndex = ws.accountAvatarIndex;
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ws = WorkspaceScope.of(context);
    final theme = Theme.of(context).textTheme;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('账户管理'),
            Text('头像与显示名称', style: theme.bodyMedium),
          ],
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.lg,
          AppSpacing.lg,
          AppSpacing.lg,
          96,
        ),
        children: [
          AppCard(
            borderRadius: AppRadius.xl,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Center(
                  child: AccountAvatar(
                    index: _avatarIndex,
                    size: 72,
                    iconSize: 34,
                  ),
                ),
                const SizedBox(height: AppSpacing.xl),
                Text('显示名称', style: theme.titleMedium),
                const SizedBox(height: AppSpacing.sm),
                TextField(
                  controller: _nameController,
                  textInputAction: TextInputAction.done,
                  maxLength: 24,
                  decoration: const InputDecoration(
                    hintText: '输入显示名称',
                    counterText: '',
                  ),
                ),
                const SizedBox(height: AppSpacing.xl),
                Text('头像', style: theme.titleMedium),
                const SizedBox(height: AppSpacing.md),
                Wrap(
                  spacing: AppSpacing.md,
                  runSpacing: AppSpacing.md,
                  children: [
                    for (int i = 0; i < accountAvatarOptions.length; i++)
                      InkWell(
                        borderRadius: BorderRadius.circular(20),
                        onTap: () => setState(() => _avatarIndex = i),
                        child: Padding(
                          padding: const EdgeInsets.all(2),
                          child: AccountAvatar(
                            index: i,
                            selected: i == _avatarIndex,
                          ),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.xl),
          SizedBox(
            height: 50,
            width: double.infinity,
            child: FilledButton(
              onPressed: () {
                ws.updateAccountProfile(
                  displayName: _nameController.text,
                  avatarIndex: _avatarIndex,
                );
                Navigator.of(context).pop();
              },
              child: const Text('保存'),
            ),
          ),
        ],
      ),
    );
  }
}
