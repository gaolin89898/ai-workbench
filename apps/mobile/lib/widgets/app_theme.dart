import 'package:flutter/material.dart';

// ===========================================================================
// 设计 Token：颜色 / 圆角 / 间距 / 阴影
// 依据 ai-workbench-mobile-design/colors_and_type.css 与各页面 HTML 提取
// ===========================================================================

/// 颜色系统。包含主色、状态色、软色板（背景 + 前景配对）。
class AppColors {
  AppColors._();

  // ---- 品牌主色 ----
  static const primary = Color(0xff2563eb);
  static const primaryHover = Color(0xff1d4ed8);
  static const primarySoft = Color(0x0f2563eb); // rgba(37,99,235,0.06)
  static const primaryMuted = Color(0x1f2563eb); // rgba(37,99,235,0.12)
  static const primarySoftSolid = Color(0xffeff6ff); // 用于不透明场景
  static const primarySoftSolid2 = Color(0xffdbeafe);

  // ---- 背景色 ----
  static const background = Color(0xfff8fafc);
  static const sidebar = Color(0xffffffff);
  static const surface = Color(0xffffffff);
  static const surfaceMuted = Color(0xfff1f5f9); // 输入框填充
  static const hover = Color(0x08000000); // rgba(0,0,0,0.02)
  static const active = Color(0x142563eb); // rgba(37,99,235,0.08)

  // ---- 文本色 ----
  static const ink = Color(0xff0f172a); // 文本 primary
  static const secondary = Color(0xff475569); // 文本 secondary
  static const muted = Color(0xff94a3b8); // 文本 muted（时间戳、未选中）
  static const inverse = Color(0xffffffff);

  // ---- 边框 ----
  static const border = Color(0xffe2e8f0);
  static const borderActive = Color(0x662563eb); // rgba(37,99,235,0.4)
  static const divider = Color(0xffedf2f7); // 内部分隔线

  // ---- 状态色 ----
  static const success = Color(0xff22c55e);
  static const successDeep = Color(0xff16a34a);
  static const successSoft = Color(0xffecfdf5);
  static const warning = Color(0xfff59e0b);
  static const warningDeep = Color(0xffea580c);
  static const warningSoft = Color(0xfffff7ed);
  static const danger = Color(0xffef4444);
  static const dangerDeep = Color(0xffdc2626);
  static const dangerSoft = Color(0xfffef2f2);
  static const info = Color(0xff3b82f6);
  static const infoSoft = Color(0xfff0f9ff);

  // ---- 品牌色（钉钉等） ----
  static const dingtalk = Color(0xff1677ff);

  // ---- 渐变 ----
  static const primaryGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xff2563eb), Color(0xff60a5fa)],
  );
  static const heroGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xff1d4ed8), Color(0xff2563eb), Color(0xff60a5fa)],
    stops: [0.0, 0.55, 1.0],
  );
}

/// 圆角。设计稿的 radius token 与页面常用值统一在此。
class AppRadius {
  AppRadius._();
  static const sm = 4.0;
  static const md = 8.0;
  static const lg = 12.0; // 卡片、输入框、消息气泡、列表内框
  static const xl = 16.0; // 项目卡、按钮
  static const x2l = 22.0; // Hero 卡、设置卡
  static const x3l = 24.0; // 登录表单卡、品牌信息卡
  static const full = 9999.0; // 圆形头像、徽章
}

/// 间距。
class AppSpacing {
  AppSpacing._();
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 20.0;
  static const x2l = 24.0;
  static const x3l = 32.0;
}

/// 阴影。Material 默认 shadow 偏浓，这里改为设计稿的轻量投影。
class AppShadows {
  AppShadows._();
  static const card = [
    BoxShadow(color: Color(0x0d000000), blurRadius: 2, offset: Offset(0, 1)),
  ]; // 0 1px 2px rgba(0,0,0,0.05)
  static const elevated = [
    BoxShadow(color: Color(0x14000000), blurRadius: 12, offset: Offset(0, 4)),
  ]; // 0 4px 12px rgba(0,0,0,0.08)
  static const primary = [
    BoxShadow(color: Color(0x402563eb), blurRadius: 24, offset: Offset(0, 12)),
  ]; // 0 12px 24px rgba(37,99,235,0.25)
}

/// 状态徽章的配对配色。用于 status pill、status dot、_Badge 等场景。
class AppStatusStyle {
  final Color bg;
  final Color fg;
  final Color? border;
  const AppStatusStyle(this.bg, this.fg, [this.border]);

  static const success = AppStatusStyle(AppColors.successSoft, AppColors.successDeep, Color(0xffbbf7d0));
  static const warning = AppStatusStyle(AppColors.warningSoft, AppColors.warningDeep);
  static const danger = AppStatusStyle(AppColors.dangerSoft, AppColors.dangerDeep);
  static const info = AppStatusStyle(AppColors.infoSoft, AppColors.info);
  static const primary = AppStatusStyle(AppColors.primarySoftSolid, AppColors.primary, AppColors.primarySoftSolid2);
  static const neutral = AppStatusStyle(AppColors.surfaceMuted, AppColors.secondary, AppColors.border);
}

// ===========================================================================
// ThemeData
// ===========================================================================

/// 中文字体回退列表。新设计在 --font-sans 中追加了 Noto Sans SC / PingFang SC /
/// Microsoft YaHei，这里在 Flutter 侧对齐。
const _kFallbackFonts = <String>[
  'Inter',
  'Noto Sans SC',
  'PingFang SC',
  'Microsoft YaHei',
  'Roboto',
];

ThemeData buildAppTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    scaffoldBackgroundColor: AppColors.background,
    // 新设计：--font-sans 追加中文字体回退
    fontFamily: 'Inter',
    fontFamilyFallback: _kFallbackFonts,
    colorScheme: const ColorScheme.light(
      primary: AppColors.primary,
      onPrimary: AppColors.inverse,
      secondary: AppColors.secondary,
      surface: AppColors.surface,
      onSurface: AppColors.ink,
      error: AppColors.danger,
      outline: AppColors.border,
    ),
  );

  return base.copyWith(
    // ---- 文本主题 ----
    textTheme: const TextTheme(
      // 大标题（登录、设置页主标题）28px
      displaySmall: TextStyle(
        fontSize: 28,
        fontWeight: FontWeight.w700,
        color: AppColors.ink,
        height: 1.2,
        letterSpacing: -0.03,
      ),
      // 章节标题 16px
      titleLarge: TextStyle(
        fontSize: 16,
        fontWeight: FontWeight.w600,
        color: AppColors.ink,
        height: 1.25,
      ),
      // 列表项标题 14px
      titleMedium: TextStyle(
        fontSize: 14,
        fontWeight: FontWeight.w600,
        color: AppColors.ink,
        height: 1.3,
      ),
      // 卡片小标题 13px
      titleSmall: TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w600,
        color: AppColors.ink,
        height: 1.4,
      ),
      // 正文 13px
      bodyLarge: TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w400,
        color: AppColors.ink,
        height: 1.5,
      ),
      // 副文字 12px
      bodyMedium: TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w400,
        color: AppColors.secondary,
        height: 1.5,
      ),
      // 元数据/时间戳 11px
      bodySmall: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w400,
        color: AppColors.muted,
        height: 1.5,
      ),
      // 按钮 14px
      labelLarge: TextStyle(
        fontSize: 14,
        fontWeight: FontWeight.w600,
        color: AppColors.inverse,
        height: 1.0,
      ),
      labelMedium: TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w500,
        color: AppColors.secondary,
      ),
      labelSmall: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w500,
        color: AppColors.muted,
      ),
    ),
    // ---- AppBar ----
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.surface,
      foregroundColor: AppColors.ink,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: AppColors.ink,
        fontSize: 18,
        fontWeight: FontWeight.w700,
        letterSpacing: -0.02,
      ),
      iconTheme: IconThemeData(color: AppColors.secondary, size: 20),
    ),
    iconTheme: const IconThemeData(color: AppColors.secondary, size: 20),
    // ---- 输入框 ----
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.surfaceMuted,
      contentPadding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
      hintStyle: const TextStyle(color: AppColors.muted, fontSize: 14),
      labelStyle: const TextStyle(color: AppColors.secondary, fontSize: 13, fontWeight: FontWeight.w500),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        borderSide: const BorderSide(color: AppColors.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        borderSide: const BorderSide(color: AppColors.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        borderSide: const BorderSide(color: AppColors.primary, width: 1.4),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        borderSide: const BorderSide(color: AppColors.danger),
      ),
    ),
    // ---- 卡片 ----
    cardTheme: CardThemeData(
      color: AppColors.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      margin: EdgeInsets.zero,
    ),
    // ---- 按钮 ----
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.primary,
        foregroundColor: AppColors.inverse,
        minimumSize: const Size.fromHeight(48),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.md),
        textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.lg)),
        elevation: 0,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.secondary,
        backgroundColor: AppColors.surface,
        minimumSize: const Size.fromHeight(48),
        side: const BorderSide(color: AppColors.border),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.md),
        textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.lg)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: AppColors.primary,
        textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
      ),
    ),
    // ---- 底部导航 ----
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: const Color(0xf2ffffff), // rgba(255,255,255,0.94)
      elevation: 0,
      height: 66,
      indicatorColor: AppColors.primarySoft,
      labelTextStyle: WidgetStateProperty.resolveWith((states) {
        final selected = states.contains(WidgetState.selected);
        return TextStyle(
          fontSize: 11,
          fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
          color: selected ? AppColors.primary : AppColors.muted,
        );
      }),
      iconTheme: WidgetStateProperty.resolveWith((states) {
        final selected = states.contains(WidgetState.selected);
        return IconThemeData(
          size: 22,
          color: selected ? AppColors.primary : AppColors.muted,
        );
      }),
      surfaceTintColor: Colors.transparent,
    ),
    // ---- 列表项 ----
    listTileTheme: const ListTileThemeData(
      iconColor: AppColors.secondary,
      contentPadding: EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(AppRadius.lg)),
      ),
    ),
    // ---- Chip / Badge ----
    chipTheme: ChipThemeData(
      backgroundColor: AppColors.surfaceMuted,
      side: const BorderSide(color: AppColors.border),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.full)),
      labelStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.secondary),
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
    ),
    // ---- 对话框 ----
    dialogTheme: DialogThemeData(
      backgroundColor: AppColors.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.x2l)),
      titleTextStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.ink),
      contentTextStyle: const TextStyle(fontSize: 13, color: AppColors.secondary, height: 1.5),
    ),
    // ---- 底部 Sheet ----
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: AppColors.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadius.x2l)),
      ),
      showDragHandle: true,
      dragHandleColor: AppColors.muted,
      dragHandleSize: Size(40, 4),
    ),
    // ---- 分隔线 ----
    dividerTheme: const DividerThemeData(
      color: AppColors.divider,
      thickness: 1,
      space: 1,
    ),
    // ---- Switch ----
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.all(AppColors.inverse),
      trackColor: WidgetStateProperty.resolveWith((states) {
        return states.contains(WidgetState.selected) ? AppColors.primary : const Color(0xffcbd5e1);
      }),
      trackOutlineColor: WidgetStateProperty.resolveWith((states) {
        return states.contains(WidgetState.selected) ? AppColors.primary : const Color(0xffcbd5e1);
      }),
      overlayColor: WidgetStateProperty.all(Colors.transparent),
      thumbIcon: WidgetStateProperty.all(const Icon(Icons.circle, color: AppColors.inverse, size: 18)),
    ),
    // ---- 滑块 ----
    sliderTheme: SliderThemeData(
      activeTrackColor: AppColors.primary,
      inactiveTrackColor: AppColors.border,
      thumbColor: AppColors.primary,
      overlayColor: AppColors.primaryMuted,
      trackHeight: 4,
    ),
    // ---- 进度条 ----
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: AppColors.primary,
      linearTrackColor: AppColors.surfaceMuted,
      circularTrackColor: Colors.transparent,
    ),
    splashFactory: NoSplash.splashFactory,
    splashColor: Colors.transparent,
    highlightColor: AppColors.hover,
  );
}

// ===========================================================================
// 公共组件
// ===========================================================================

/// 通用卡片。圆角 12 + 边框 + 轻阴影。
class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.lg),
    this.onTap,
    this.onLongPress,
    this.borderColor,
    this.background,
    this.borderRadius = AppRadius.lg,
    this.shadow = AppShadows.card,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final Color? borderColor;
  final Color? background;
  final double borderRadius;
  final List<BoxShadow> shadow;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(borderRadius);
    final card = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: background ?? AppColors.surface,
        border: Border.all(color: borderColor ?? AppColors.border),
        borderRadius: radius,
        boxShadow: shadow,
      ),
      child: child,
    );
    if (onTap == null && onLongPress == null) return card;
    return InkWell(
      borderRadius: radius,
      onTap: onTap,
      onLongPress: onLongPress,
      child: card,
    );
  }
}

/// 章节标题。如「快捷操作」「最近会话」。
class AppSectionTitle extends StatelessWidget {
  const AppSectionTitle(
    this.text, {
    super.key,
    this.subtitle,
    this.trailing,
    this.padding = EdgeInsets.zero,
    this.titleStyle,
  });

  final String text;
  final String? subtitle;
  final Widget? trailing;
  final EdgeInsetsGeometry padding;

  /// 自定义标题文字样式。不传时默认使用 textTheme.titleLarge。
  final TextStyle? titleStyle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: padding,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  text,
                  style: titleStyle ?? Theme.of(context).textTheme.titleLarge,
                ),
                if (subtitle != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(subtitle!, style: Theme.of(context).textTheme.bodyMedium),
                  ),
              ],
            ),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

/// 状态徽章（pill）。软色板配色。
class AppStatusBadge extends StatelessWidget {
  const AppStatusBadge(
    this.label, {
    super.key,
    this.style = AppStatusStyle.neutral,
    this.dot = false,
  });

  final String label;
  final AppStatusStyle style;
  final bool dot; // 是否显示左侧圆点

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: style.bg,
        borderRadius: BorderRadius.circular(AppRadius.full),
        border: style.border != null ? Border.all(color: style.border!) : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot)
            Padding(
              padding: const EdgeInsets.only(right: 5),
              child: Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(color: style.fg, shape: BoxShape.circle),
              ),
            ),
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: style.fg,
            ),
          ),
        ],
      ),
    );
  }
}

/// 状态圆点。
class AppStatusDot extends StatelessWidget {
  const AppStatusDot({
    super.key,
    this.size = 8,
    this.color = AppColors.success,
  });

  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

/// 图标方框。用于列表项左侧的带色背景图标。
class AppIconBox extends StatelessWidget {
  const AppIconBox({
    super.key,
    required this.icon,
    this.size = 40,
    this.iconSize = 18,
    this.background = AppColors.primarySoftSolid,
    this.foreground = AppColors.primary,
    this.border,
    this.borderRadius = AppRadius.md,
  });

  final IconData icon;
  final double size;
  final double iconSize;
  final Color background;
  final Color foreground;
  final Color? border;
  final double borderRadius;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(borderRadius),
        border: border != null ? Border.all(color: border!) : null,
      ),
      child: Icon(icon, color: foreground, size: iconSize),
    );
  }
}

/// 空状态。
class EmptyState extends StatelessWidget {
  const EmptyState(this.message, {super.key, this.icon});

  final String message;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.x2l),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.md),
                child: Icon(icon, size: 40, color: AppColors.muted),
              ),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColors.muted, height: 1.5, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}
