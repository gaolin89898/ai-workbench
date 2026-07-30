# 聊天搜索功能实现计划

## 目标
为桌面端实现对话历史的全文搜索功能，允许用户在会话列表和消息内容中快速查找相关信息。

## 当前状态分析

### 数据库结构
- `local_ai_sessions`: 存储会话元数据（title, summary, provider_id, status等）
- `local_ai_messages`: 存储消息内容（role, content, agent_role, created_at）
- `local_ai_traces`: 存储执行轨迹（raw_events, snapshot, final_text）
- 已有索引：`idx_local_ai_messages_session`, `idx_local_ai_traces_session`
- **未使用 SQLite FTS（全文搜索）**

### 前端结构
- `WorkspaceView.vue`: 显示会话列表，当前无搜索功能
- `useWorkspace.ts`: 管理会话状态，有 `activeSessions` 和 `archivedSessions` computed
- `db.ts`: 
  - `listLocalAiSessions()`: 简单按 updated_at DESC 排序
  - `listLocalAiHistory(aiSessionId)`: 获取单个会话的消息历史
- `ipc.ts`: `list_local_ai_sessions` IPC handler 已存在

### 现有 UI 模式
- WorkspaceView.vue 有会话列表展示
- 有"已归档"切换按钮
- 会话卡片显示 title、provider、projectPath/summary

## 实现方案

### 方案 A: SQLite FTS5 全文索引（推荐）
**优点**：
- 性能最佳，适合大量历史数据
- 支持中文分词、排序、高亮
- SQLite FTS5 内置，无需额外依赖
- 可索引会话标题、消息内容、执行轨迹

**缺点**：
- 需要数据库迁移创建 FTS 虚拟表
- 需要维护 FTS 表与原表同步（触发器）

**实现步骤**：
1. 在 `db.ts` 中创建 FTS5 虚拟表和触发器
2. 添加 `searchLocalAiSessions(query)` 和 `searchLocalAiMessages(query)` 函数
3. 添加 IPC handlers: `search_ai_sessions`, `search_ai_messages`
4. 在 `WorkspaceView.vue` 添加搜索输入框
5. 实现搜索结果高亮和结果列表

### 方案 B: LIKE 查询（简单但性能差）
**优点**：
- 实现简单，无需数据库迁移
- 适合少量数据

**缺点**：
- 性能随数据增长线性下降
- 不支持中文分词
- 无相关性排序

## 推荐方案：FTS5 全文索引

### 数据库层（db.ts）

#### 1. 创建 FTS5 虚拟表
```typescript
// 会话搜索：索引 title, summary, project_path
CREATE VIRTUAL TABLE IF NOT EXISTS local_ai_sessions_fts USING fts5(
  id UNINDEXED,
  title,
  summary,
  project_path,
  content='local_ai_sessions',
  content_rowid='rowid'
);

// 消息搜索：索引 content, agent_role
CREATE VIRTUAL TABLE IF NOT EXISTS local_ai_messages_fts USING fts5(
  id UNINDEXED,
  ai_session_id UNINDEXED,
  role UNINDEXED,
  content,
  agent_role,
  content='local_ai_messages',
  content_rowid='id'
);
```

#### 2. 创建触发器保持 FTS 同步
```typescript
// 会话表触发器
CREATE TRIGGER IF NOT EXISTS local_ai_sessions_fts_insert AFTER INSERT ON local_ai_sessions
BEGIN
  INSERT INTO local_ai_sessions_fts(rowid, id, title, summary, project_path)
  VALUES (NEW.rowid, NEW.id, NEW.title, NEW.summary, NEW.project_path);
END;

CREATE TRIGGER IF NOT EXISTS local_ai_sessions_fts_update AFTER UPDATE ON local_ai_sessions
BEGIN
  UPDATE local_ai_sessions_fts 
  SET title=NEW.title, summary=NEW.summary, project_path=NEW.project_path
  WHERE rowid=NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS local_ai_sessions_fts_delete AFTER DELETE ON local_ai_sessions
BEGIN
  DELETE FROM local_ai_sessions_fts WHERE rowid=OLD.rowid;
END;

// 消息表触发器（类似）
```

#### 3. 初始化 FTS 表数据
```typescript
// 为现有数据建立索引
INSERT INTO local_ai_sessions_fts(rowid, id, title, summary, project_path)
SELECT rowid, id, title, summary, project_path FROM local_ai_sessions;

INSERT INTO local_ai_messages_fts(rowid, id, ai_session_id, role, content, agent_role)
SELECT id, id, ai_session_id, role, content, agent_role FROM local_ai_messages;
```

#### 4. 搜索函数
```typescript
export function searchLocalAiSessions(query: string): AiSession[] {
  if (!query.trim()) return listLocalAiSessions();
  
  const rows = db.prepare(`
    SELECT s.* FROM local_ai_sessions s
    JOIN local_ai_sessions_fts fts ON s.rowid = fts.rowid
    WHERE local_ai_sessions_fts MATCH ?
    ORDER BY rank, s.updated_at DESC
  `).all(query) as SessionRow[];
  
  return rows.map(rowToSession);
}

export function searchLocalAiMessages(
  query: string, 
  limit: number = 50
): Array<{sessionId: string; messageId: number; content: string; createdAt: string}> {
  if (!query.trim()) return [];
  
  const rows = db.prepare(`
    SELECT m.ai_session_id, m.id, m.content, m.created_at
    FROM local_ai_messages m
    JOIN local_ai_messages_fts fts ON m.id = fts.rowid
    WHERE local_ai_messages_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit);
  
  return rows.map(row => ({
    sessionId: row.ai_session_id,
    messageId: row.id,
    content: row.content,
    createdAt: row.created_at
  }));
}
```

### IPC 层（ipc.ts）

```typescript
handle("search_ai_sessions", async (_event, args: [string]) => {
  const [query] = args;
  return db.searchLocalAiSessions(query);
});

handle("search_ai_messages", async (_event, args: [string, number?]) => {
  const [query, limit] = args;
  return db.searchLocalAiMessages(query, limit ?? 50);
});
```

### 前端层

#### 1. WorkspaceView.vue UI
- 在会话列表上方添加搜索输入框
- 实时搜索（防抖 300ms）
- 显示搜索结果数量
- 高亮匹配文本

```vue
<template>
  <!-- 在会话列表上方 -->
  <div class="search-box">
    <input 
      v-model="searchQuery" 
      type="search" 
      placeholder="搜索会话标题、内容..." 
      @input="onSearchInput"
    />
    <span v-if="searchQuery" class="search-count">
      找到 {{ filteredSessions.length }} 个会话
    </span>
  </div>
  
  <!-- 会话列表改用 filteredSessions -->
  <article v-for="session in filteredSessions" ...>
</template>
```

#### 2. useWorkspace.ts 逻辑
```typescript
const searchQuery = ref("");
const searchResults = ref<AiSession[]>([]);
const isSearching = ref(false);

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function performSearch(query: string) {
  if (!query.trim()) {
    searchResults.value = [];
    return;
  }
  
  isSearching.value = true;
  try {
    const results = await desktopApi.ipc.searchAiSessions(query);
    searchResults.value = results;
  } catch (error) {
    console.error("Search failed:", error);
    searchResults.value = [];
  } finally {
    isSearching.value = false;
  }
}

function onSearchInput() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    performSearch(searchQuery.value);
  }, 300);
}

const filteredSessions = computed(() => {
  if (!searchQuery.value.trim()) {
    return showArchivedSessions.value ? archivedSessions.value : activeSessions.value;
  }
  return searchResults.value;
});
```

### 高级功能（可选）

#### 1. 消息内容搜索
- 独立页面或侧边栏显示消息搜索结果
- 点击结果跳转到对应会话和消息位置
- 显示上下文片段

#### 2. 搜索语法
- 支持引号精确匹配: `"exact phrase"`
- 支持 NOT 排除: `keyword NOT excluded`
- 支持字段限定: `title:关键词`

#### 3. 搜索历史
- localStorage 存储最近搜索
- 快速选择历史搜索词

## 实施顺序

1. **数据库迁移**（db.ts）
   - 创建 FTS5 虚拟表
   - 创建触发器
   - 初始化现有数据索引
   - 添加搜索函数

2. **IPC 接口**（ipc.ts）
   - 注册 search_ai_sessions handler
   - 注册 search_ai_messages handler（可选）

3. **前端 UI**（WorkspaceView.vue + useWorkspace.ts）
   - 添加搜索输入框
   - 实现防抖搜索逻辑
   - 显示搜索结果
   - 添加结果计数提示

4. **测试验证**
   - 测试中文搜索
   - 测试空查询处理
   - 测试大量数据性能
   - 测试触发器同步

## 潜在问题与解决

### 问题1: FTS5 中文分词
**现象**：FTS5 默认按空格分词，中文需要特殊处理

**解决**：使用 `tokenize='unicode61'` 或 `tokenize='porter unicode61'`，支持 CJK 字符按字分词

### 问题2: 现有数据迁移
**现象**：用户已有历史数据需要建立索引

**解决**：在数据库初始化时检测 FTS 表是否为空，如果为空则执行批量插入

### 问题3: 搜索性能
**现象**：大量消息时搜索可能变慢

**解决**：
- 限制结果数量（LIMIT）
- 只搜索最近 N 个月的数据
- 添加搜索进度提示

## 成功标准

- [ ] 用户可以在会话列表搜索标题、摘要、项目路径
- [ ] 搜索支持中文和英文
- [ ] 搜索结果按相关性排序
- [ ] 搜索响应时间 < 300ms（1000条会话）
- [ ] FTS 触发器正确同步增删改操作
- [ ] 空查询时显示所有会话（不报错）
- [ ] 搜索框有防抖处理，避免过度查询
