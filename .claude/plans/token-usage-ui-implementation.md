# Token 使用统计 UI 实现计划

## 目标
在桌面端添加 Token 使用统计展示，让用户了解各 Provider 的 token 消耗和花费情况。

## 当前状态分析

### 后端功能（已完成）
- ✅ 所有 Provider 都在上报 token 使用：`reportTokenUsage()`
- ✅ 后端聚合统计：`fetchTokenUsageSummary(days)`
- ✅ IPC handler 已注册：`get_token_usage_summary`
- ✅ 前端 API 方法已存在：`desktopApi.ipc.getTokenUsageSummary(days)`

### 数据结构
```typescript
TokenUsageSummary {
  providers: TokenUsageSummaryItem[];  // 按 Provider 分组
  totals: TokenUsageSummaryItem;       // 总计
  daily?: TokenUsageDailyItem[];       // 每日明细（可选）
  periodDays?: number;                 // 统计周期
}

TokenUsageSummaryItem {
  providerId: string;           // codex, claude, opencode, mimo
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  turnCount: number;            // 对话轮数
}
```

### Provider 名称映射
```typescript
const PROVIDER_NAMES = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  mimo: "MiMo Code"
};
```

## 实现方案

### 方案：独立的 Token 统计面板

#### 位置选择
**选项 A: 设置页面新增 Token 统计标签**
- 在 SettingsView.vue 中添加新的 tab
- 与账号、Provider 设置并列
- 适合查看历史统计

**选项 B: 工作台首页添加 Token 卡片**
- 在 WorkspaceView.vue 的 metrics-grid 中添加
- 显示当月总 token 使用量
- 点击查看详情弹窗

**推荐：选项 A + 首页卡片摘要**
- 首页显示当月总 token 数（简洁）
- 设置页完整统计面板（详细）

### UI 组件结构

#### 1. TokenUsagePanel.vue（设置页完整面板）

**布局**：
```
┌─────────────────────────────────────┐
│ Token 使用统计                       │
│ [7天] [30天] [90天]  刷新          │
├─────────────────────────────────────┤
│ 总计                                │
│ ▸ 总 Token: 1,234,567              │
│   输入: 800,000 | 输出: 400,000     │
│   缓存: 34,567  | 推理: 0           │
│   对话轮数: 456                     │
├─────────────────────────────────────┤
│ 按 Provider 统计                    │
│ ┌─────────────────────────────────┐ │
│ │ Codex              67.8%        │ │
│ │ ████████████████░░░░░░░        │ │
│ │ 836,789 tokens · 312 轮        │ │
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ Claude Code        23.4%        │ │
│ │ ███████░░░░░░░░░░░░░░░          │ │
│ │ 289,012 tokens · 98 轮         │ │
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ MiMo Code          8.8%         │ │
│ │ ██░░░░░░░░░░░░░░░░░░░░          │ │
│ │ 108,766 tokens · 46 轮         │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ 每日趋势（可选）                     │
│ [简单条形图或折线图]                 │
└─────────────────────────────────────┘
```

**功能**：
- 时间范围切换（7/30/90 天）
- 显示总计和分 Provider 统计
- 百分比进度条
- Token 数量格式化（千分位逗号）
- 刷新按钮

#### 2. WorkspaceView.vue 首页摘要卡片

在 metrics-grid 中添加第 4 个卡片：
```vue
<article class="metric-card">
  <p>Token 用量</p>
  <strong>{{ formatTokenCount(tokenSummary.totals.totalTokens) }}</strong>
  <span>最近 30 天</span>
</article>
```

### 实现步骤

#### 阶段 1: 创建 TokenUsagePanel 组件

1. 创建 `apps/desktop/src/components/TokenUsagePanel.vue`
2. 添加数据加载逻辑
3. 实现 UI 布局
4. 添加时间范围切换
5. 格式化数字显示

**核心逻辑**：
```typescript
const tokenSummary = ref<TokenUsageSummary | null>(null);
const selectedPeriod = ref<7 | 30 | 90>(30);
const loading = ref(false);

async function loadTokenUsage() {
  loading.value = true;
  try {
    tokenSummary.value = await desktopApi.ipc.getTokenUsageSummary(selectedPeriod.value);
  } catch (error) {
    console.error("Failed to load token usage:", error);
  } finally {
    loading.value = false;
  }
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return count.toLocaleString();
}

function getProviderPercentage(item: TokenUsageSummaryItem): number {
  if (!tokenSummary.value?.totals.totalTokens) return 0;
  return (item.totalTokens / tokenSummary.value.totals.totalTokens) * 100;
}

onMounted(() => loadTokenUsage());
watch(selectedPeriod, () => loadTokenUsage());
```

#### 阶段 2: 集成到 SettingsView

1. 在 SettingsView.vue 添加新的 tab："token-usage"
2. 导入 TokenUsagePanel 组件
3. 添加路由支持

```vue
<template>
  <div class="settings-tabs">
    <button @click="selectTab('account')">账号</button>
    <button @click="selectTab('providers')">Provider</button>
    <button @click="selectTab('token-usage')">Token 统计</button>
  </div>
  
  <TokenUsagePanel v-if="activeTab === 'token-usage'" />
</template>
```

#### 阶段 3: 工作台首页摘要

1. 在 useWorkspace.ts 添加 token 摘要加载
2. 在 WorkspaceView.vue 添加摘要卡片
3. 点击卡片跳转到设置页 Token 统计

```typescript
// useWorkspace.ts
const tokenSummaryCache = ref<TokenUsageSummary | null>(null);

async function loadTokenSummaryForDashboard() {
  try {
    tokenSummaryCache.value = await desktopApi.ipc.getTokenUsageSummary(30);
  } catch {
    // 静默失败，不显示摘要
  }
}
```

### 样式设计

```css
.token-usage-panel {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px;
}

.token-usage-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.token-usage-period-tabs {
  display: flex;
  gap: 8px;
}

.token-usage-period-tabs button {
  padding: 6px 16px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-content);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s ease;
}

.token-usage-period-tabs button.active {
  background: var(--color-primary);
  color: white;
  border-color: var(--color-primary);
}

.token-usage-totals {
  padding: 20px;
  background: var(--color-bg-surface);
  border-radius: var(--radius-lg);
}

.token-usage-totals h3 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}

.token-usage-totals .token-count {
  font-size: 32px;
  font-weight: 700;
  color: var(--color-primary);
}

.token-usage-breakdown {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-top: 16px;
  font-size: 13px;
}

.token-usage-providers {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.token-usage-provider-card {
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-content);
}

.token-usage-provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.token-usage-provider-name {
  font-size: 14px;
  font-weight: 600;
}

.token-usage-provider-percentage {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.token-usage-progress-bar {
  height: 8px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-full);
  overflow: hidden;
  margin: 8px 0;
}

.token-usage-progress-fill {
  height: 100%;
  background: var(--color-primary);
  transition: width 0.3s ease;
}

.token-usage-provider-stats {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
```

### 数据刷新策略

- 首次加载：进入设置页时自动加载
- 手动刷新：用户点击刷新按钮
- 自动刷新：不实现（token 统计是历史数据，变化慢）
- 缓存：使用 ref 缓存，切换 tab 不重新加载

### 可选增强功能

1. **每日趋势图表** - 使用简单的 CSS 条形图或引入轻量图表库
2. **导出 CSV** - 导出 token 使用明细
3. **预估费用** - 根据各 Provider 定价计算预估费用（需要价格配置）
4. **告警阈值** - 超过设定 token 数量时提示

### 测试要点

- 测试无数据时的空状态显示
- 测试 API 失败时的错误处理
- 测试不同时间范围的切换
- 测试数字格式化（大数、小数）
- 测试各 Provider 百分比计算准确性

## 实施顺序

1. 创建 TokenUsagePanel.vue 基础组件
2. 实现数据加载和显示逻辑
3. 添加样式和交互
4. 集成到 SettingsView
5. 在 WorkspaceView 添加首页摘要卡片（可选）
6. 测试和完善

## 成功标准

- [ ] 用户可以在设置页查看 Token 统计
- [ ] 支持 7/30/90 天时间范围切换
- [ ] 显示总计和按 Provider 分组统计
- [ ] Token 数量正确格式化（千分位、K/M 单位）
- [ ] 百分比进度条直观展示各 Provider 占比
- [ ] 加载状态和错误处理完善
- [ ] 首页显示 Token 使用摘要（可选）
