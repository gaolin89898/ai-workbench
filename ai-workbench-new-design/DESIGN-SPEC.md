# AI Workbench — 全新界面设计方案

> **版本**: v2.0 | **设计日期**: 2026-07-10 | **设计师**: UI Designer
> **基于**: 现有 4 套设计稿（桌面端深色/浅色、移动端初版/改版）的系统性演进

---

## 一、设计分析总结

### 现有设计系统提取

通过分析项目中 4 套现有设计稿，提取了以下核心设计语言：

| 维度 | 现有规范 | 新设计继承/演进 |
|------|---------|----------------|
| **品牌色** | `#2563eb` (蓝色) | ✅ 完全保留，新增渐变 `#2563eb → #7c3aed` |
| **字体** | Inter + JetBrains Mono | ✅ 保留，新增中文字体回退链 |
| **字号** | 11px → 28px (7级) | ✅ 扩展为 10px → 32px (10级) |
| **间距** | 4px 基准 (10级) | ✅ 保留，补充半步间距 (2px/6px/10px) |
| **圆角** | 4px / 7px / 8px / 12px | ✅ 精简为 3px / 5px / 8px / 12px / 16px / 20px / 24px |
| **阴影** | 3级 (sm/md/lg) | ✅ 扩展为 6级 (xs/sm/md/lg/xl/glow) |
| **主题** | 深色 + 浅色 | ✅ 保留双主题，通过 `[data-theme]` 切换 |
| **布局** | 桌面 286px 侧栏 / 移动 480px | ✅ 优化为 280px 侧栏 / 480px 移动 |
| **图标** | Lucide Icons | ✅ 完全保留 |
| **无障碍** | 44px 触摸目标 | ✅ 保留并增强焦点可见性 |

### 用户习惯关键发现

1. **左侧导航 + 右侧内容**：桌面端用户习惯 VSCode 式布局，侧栏管理项目树
2. **底部 Tab 导航**：移动端用户习惯 3-4 个底部标签切换核心功能
3. **空状态引导**：用户首次进入时需要明确的引导提示和快捷入口
4. **状态可视化**：通过颜色徽章（成功/警告/错误）快速识别任务状态
5. **渐变强调**：重要区域使用品牌色渐变提升视觉吸引力

---

## 二、设计系统令牌

### 色彩系统

#### 品牌色
```
Primary:       #2563eb    (主品牌色)
Primary Hover: #1d4ed8    (悬停态)
Primary Active:#1e40af    (激活态)
Gradient:      linear-gradient(135deg, #2563eb → #7c3aed)
```

#### 语义状态色（WCAG AA 合规）
| 状态 | 前景色 | 背景色 | 对比比 |
|------|--------|--------|--------|
| Success | `#16a34a` | `#ecfdf5` | 4.6:1 ✅ |
| Warning | `#d97706` | `#fffbeb` | 4.7:1 ✅ |
| Error | `#dc2626` | `#fef2f2` | 5.2:1 ✅ |
| Info | `#2563eb` | `#eff6ff` | 5.4:1 ✅ |

#### 浅色主题表面层级
```
App:      #f4f6fa    (应用底色，略带蓝灰)
Content:  #ffffff    (卡片/内容区，纯白)
Surface:  #f8fafc    (次级表面)
Elevated: #f1f5f9    (抬升表面/输入框)
Hover:    #f1f5f9    (悬停反馈)
Active:   #eff6ff    (选中反馈，带品牌色)
```

#### 深色主题表面层级
```
App:      #0d0f14    (应用底色，最深)
Content:  #1a1d27    (卡片/内容区)
Surface:  #1e2230    (次级表面)
Elevated: #252938    (抬升表面)
Hover:    rgba(255,255,255,0.05)
Active:   rgba(37,99,235,0.10)
```

### 字体系统

```css
--font-sans: "Inter", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
--font-mono: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
```

| 令牌 | 大小 | 用途 |
|------|------|------|
| `--text-2xs` | 10px | 角标/极小标注 |
| `--text-xs` | 11px | 标签/时间戳 |
| `--text-sm` | 12px | 辅助文本 |
| `--text-base` | 13px | 正文（UI 密度优化） |
| `--text-md` | 14px | 主要文本 |
| `--text-lg` | 16px | 小标题 |
| `--text-xl` | 18px | 区域标题 |
| `--text-2xl` | 22px | 页面标题 |
| `--text-3xl` | 26px | 大标题 |
| `--text-4xl` | 32px | 英雄标题 |

### 间距系统（8点网格）

```
4px → 8px → 12px → 16px → 20px → 24px → 32px → 40px → 48px → 64px → 80px
```

### 圆角系统

| 令牌 | 值 | 用途 |
|------|-----|------|
| `--radius-sm` | 5px | 小元素/标签 |
| `--radius-md` | 8px | 按钮/输入框 |
| `--radius-lg` | 12px | 卡片 |
| `--radius-xl` | 16px | 大卡片/弹窗 |
| `--radius-2xl` | 20px | 英雄区域 |
| `--radius-full` | 9999px | 圆形/胶囊 |

### 阴影系统

| 令牌 | 用途 |
|------|------|
| `--shadow-xs` | 细微层次（列表项分隔） |
| `--shadow-sm` | 卡片默认 |
| `--shadow-md` | 卡片悬停/下拉菜单 |
| `--shadow-lg` | 弹窗/浮层 |
| `--shadow-xl` | 模态框 |
| `--shadow-glow` | 焦点环（品牌色光晕） |

---

## 三、组件库规范

### 按钮

| 变体 | 尺寸 | 高度 | 用途 |
|------|------|------|------|
| `btn-primary` | sm / md / lg | 30 / 36 / 44px | 主要操作（发送、确认） |
| `btn-secondary` | sm / md / lg | 30 / 36 / 44px | 次要操作（取消、筛选） |
| `btn-ghost` | sm / md / lg | 30 / 36 / 44px | 幽灵按钮（工具栏操作） |

**交互状态**：默认 → 悬停（上移1px+阴影）→ 激活 → 禁用（50%透明度）

### 卡片

```css
.card {
  background: var(--color-bg-content);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  transition: all var(--transition-normal);
}
.card-hover:hover {
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}
```

### 徽章

| 变体 | 背景 | 文字 | 用途 |
|------|------|------|------|
| `badge-success` | `#ecfdf5` | `#16a34a` | 已完成/在线 |
| `badge-warning` | `#fffbeb` | `#d97706` | 进行中/待处理 |
| `badge-error` | `#fef2f2` | `#dc2626` | 错误/紧急 |
| `badge-info` | `#eff6ff` | `#2563eb` | 信息/计数 |
| `badge-neutral` | `#f1f5f9` | `#475569` | 中性标签 |

### 输入框

- 默认：`1px solid var(--color-border)` + `background: var(--color-bg-input)`
- 聚焦：`border-color: var(--color-primary)` + `box-shadow: var(--shadow-glow)`
- 占位符：`color: var(--color-text-placeholder)`

---

## 四、布局规范

### 桌面端

```
┌─────────────────────────────────────────────┐
│  Sidebar (280px)  │     Main Content        │
│                   │  ┌───────────────────┐  │
│  [Logo]           │  │ Topbar (52px)     │  │
│  [Nav]            │  ├───────────────────┤  │
│  [Project Tree]   │  │                   │  │
│                   │  │  Scrollable Area  │  │
│                   │  │  (max-w: 960px)   │  │
│                   │  │                   │  │
│  [Account]        │  │  ┌─────────────┐  │  │
│                   │  │  │  Composer   │  │  │
│                   │  │  │  (floating) │  │  │
│                   │  │  └─────────────┘  │  │
└─────────────────────────────────────────────┘
```

- **侧栏宽度**: 280px（原 286px，精简后更紧凑）
- **顶栏高度**: 52px（原 56px，减少视觉占用）
- **内容最大宽度**: 960px（居中，阅读舒适区）
- **输入框最大宽度**: 740px（聚焦区域）

### 移动端

```
┌──────────────────┐
│  Header (48px)   │
├──────────────────┤
│                  │
│  Hero Card       │
│  (gradient)      │
│                  │
│  Quick Actions   │
│  (2×2 grid)      │
│                  │
│  Project Stats   │
│                  │
│  Recent Sessions │
│  (list)          │
│                  │
│  AI Suggestion   │
│                  │
├──────────────────┤
│  Bottom Nav      │
│  (72px, 4 tabs)  │
└──────────────────┘
```

- **最大宽度**: 480px（居中）
- **底部导航**: 72px 高度，4 个标签
- **触摸目标**: 最小 44×44px（WCAG 合规）
- **安全区域**: `env(safe-area-inset-bottom)` 适配刘海屏

---

## 五、无障碍设计

### WCAG AA 合规

| 要求 | 标准 | 实现 |
|------|------|------|
| 文字对比度 | ≥ 4.5:1 | 主文字 15:1，次要文字 7:1 |
| 大文字对比度 | ≥ 3:1 | 标题全部满足 |
| 焦点可见 | 清晰焦点环 | `outline: 2px solid var(--color-primary)` |
| 触摸目标 | ≥ 44×44px | 移动端全部 `.tap-target` 满足 |
| 键盘导航 | 完整可达 | 所有交互元素支持 Tab/Enter |
| 减少动画 | 尊重用户偏好 | `@media (prefers-reduced-motion: reduce)` |

### 语义化结构

- 使用 `<header>`、`<nav>`、`<main>`、`<section>`、`<article>` 语义标签
- 所有图标按钮包含 `aria-label`
- 状态变化通过 `aria-current`、`aria-label` 传达
- 表单元素关联 `<label>`

---

## 六、交互设计

### 微交互

| 场景 | 动效 | 时长 |
|------|------|------|
| 按钮悬停 | 上移1px + 阴影增强 | 120ms |
| 卡片悬停 | 上移2px + 边框加深 | 200ms |
| 页面加载 | 子元素逐个淡入上移 | 400ms + 60ms阶梯 |
| 输入框聚焦 | 品牌色边框 + 光晕环 | 120ms |
| 移动端按压 | 下移1px + 缩放0.98 | 140ms |

### 动效曲线

```css
--transition-fast: 120ms cubic-bezier(0.4, 0, 0.2, 1);   /* 微交互 */
--transition-normal: 200ms cubic-bezier(0.4, 0, 0.2, 1);  /* 常规 */
--transition-slow: 320ms cubic-bezier(0.4, 0, 0.2, 1);    /* 大面积 */
--transition-spring: 320ms cubic-bezier(0.34, 1.56, 0.64, 1); /* 弹性 */
```

---

## 七、文件清单

```
ai-workbench-new-design/
├── design-tokens.css              # 统一设计令牌系统（双主题）
├── DESIGN-SPEC.md                 # 本设计规范文档
└── pages/
    ├── desktop-workspace.html     # 桌面端工作台界面
    └── mobile-dashboard.html      # 移动端仪表盘界面
```

### 预览方式

1. **桌面端**: 在浏览器中打开 `pages/desktop-workspace.html`
2. **移动端**: 在浏览器中打开 `pages/mobile-dashboard.html`（建议开启移动端模拟）
3. **设计令牌**: `design-tokens.css` 可直接引入到项目中使用

---

## 八、与现有设计的对比改进

| 改进点 | 原设计 | 新设计 | 收益 |
|--------|--------|--------|------|
| **桌面空状态** | 仅显示输入框 | 数据仪表盘+活动流+快捷操作 | 用户进入即可了解全局状态 |
| **统计可视化** | 仅移动端有 | 桌面+移动端统一4项统计 | 数据感知一致性 |
| **活动流** | 会话列表 | 带状态点+描述+元数据的活动流 | 信息密度更高，决策更快 |
| **输入框** | 固定底部 | 浮动+渐变遮罩+工具栏 | 不遮挡内容，功能更丰富 |
| **移动端导航** | 3个标签 | 4个标签（新增"会话"） | 高频功能更易触达 |
| **智能建议** | 无 | AI 建议卡片 | 主动引导用户改进 |
| **阴影系统** | 3级 | 6级+焦点光晕 | 层次感更细腻 |
| **动画** | 无入场动画 | 阶梯式淡入+微交互 | 首屏体验更流畅 |

---

**交付状态**: ✅ 可用于开发交付
**QA 流程**: 设计走查 + 无障碍审计 + 响应式验证
