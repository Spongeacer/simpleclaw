# SimpleClaw 重构实施方案

> 基于 OpenClaw (`openclaw/openclaw@main`, 2026.4.27) 实际源码结构制定的精简重构路线图。

---

## 一、现状诊断（基于实际代码）

### 1.1 代码规模实测

| 模块 | 文件数 | 说明 |
|---|---|---|
| `src/` | 7,482 TS 文件 | 核心运行时，含 50+ 子模块 |
| `extensions/` | 5,380 TS 文件 / 125 目录 | 通道适配器、模型提供商、工具扩展 |
| `ui/` | 317 TS/TSX 文件 | Control UI |
| `packages/` | 115 TS 文件 | 子包 |
| `apps/` | Android/iOS/macOS | 原生客户端 |
| **合计** | **~13,300+ TS 文件** | 远超文档预估的 430K 行 |

### 1.2 核心病灶定位

#### 病灶 A：依赖层 — `node-llama-cpp` 硬捆绑
- **位置**：根目录 `package.json` -> `dependencies` -> `"node-llama-cpp"`
- **影响**：安装体积 670MB+，即使从不使用本地模型也必须下载
- **根因**：直接列入 `dependencies`，无平台条件判断

#### 病灶 B：架构层 — `extensions/` 成为第二代码库
- **位置**：`extensions/` 下 125 个目录
- **症状**：
  - 通道适配器（discord, bluebubbles, telegram, slack...）与核心强耦合
  - 模型提供商（anthropic, openai, deepseek, azure...）全部内置
  - 工具扩展（browser, web-search, image-generation...）无法按需卸载
- **影响**：核心代码量失控，安全补丁需改 125 处

#### 病灶 C：Gateway 状态内聚
- **位置**：`src/gateway/{protocol,server,server-methods,voiceclaw-realtime}`
- **症状**：4 个目录但耦合了 WebSocket 连接、会话状态、认证、速率限制、实时语音
- **影响**：内存占用 ~390MB，无法水平扩展

#### 病灶 D：Agent 无认知分层
- **位置**：`src/agents/{runtime-plan,harness,tools,sandbox,...}`
- **症状**：`runtime-plan` 存在但无 Review 阶段，Plan→Execute 无边界检查
- **影响**：复杂任务边执行边规划，路径错误率高

#### 病灶 E：记忆系统单文件膨胀
- **位置**：`src/memory/` + `extensions/active-memory/`
- **症状**：MEMORY.md 线性存储 + lossy compaction，无树形索引
- **影响**：长会话准确率 60-70%

---

## 二、目标架构：洋葱模型（SimpleClaw）

```
┌─────────────────────────────────────────────┐
│  Layer 4: Channels & Extensions（插件市场）   │
│  Discord / Telegram / Slack / Anthropic ... │
│  独立 npm 包，按需 `npm install @simpleclaw/ext-discord` │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  Layer 3: Gateway（无状态控制平面）            │
│  消息路由 · 认证 · 速率限制 · 事件总线          │
│  不存储会话状态，只转发与调度                   │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  Layer 2: Agent Runtime（编排引擎）            │
│  Plan-Review-Execute 管道 · 多模型路由        │
│  工具注册表 · 上下文组装 · 安全策略执行          │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│  Layer 1: Core（不可再精简的内核）              │
│  协议定义 · 配置 Schema · 插件加载器 · 日志      │
│  目标: <50MB 安装, <20K 行代码                 │
└─────────────────────────────────────────────┘
```

---

## 三、分阶段实施路线图

### 阶段一：依赖瘦身（P0，预估 2 周）

#### 3.1.1 `node-llama-cpp` 懒加载改造

**OpenClaw 现状**：
```json
// package.json
"dependencies": {
  "node-llama-cpp": "^x.x.x",
  ...
}
```

**SimpleClaw 改造**：
```json
// package.json
"optionalDependencies": {
  "node-llama-cpp": "^x.x.x"
},
"peerDependenciesMeta": {
  "node-llama-cpp": {
    "optional": true
  }
}
```

**运行时动态加载**：
```typescript
// src/model-catalog/local-model-loader.ts
export async function loadLocalModelEngine() {
  try {
    const { LlamaModel } = await import('node-llama-cpp');
    return new LocalModelEngine(LlamaModel);
  } catch (e) {
    throw new SimpleClawError(
      'LOCAL_MODEL_NOT_INSTALLED',
      '本地模型引擎未安装。请运行: npm install node-llama-cpp'
    );
  }
}
```

#### 3.1.2 Extensions 依赖解耦

**OpenClaw 现状**：125 个 extension 的代码全部在 monorepo 中，构建时全量打包。

**SimpleClaw 改造**：
- 将 `extensions/` 改造为独立 npm 组织 `@simpleclaw-ext/`
- 核心只保留接口定义：
  ```typescript
  // src/core/extension-contract.ts
  export interface ChannelAdapter {
    authenticate(credentials: AuthConfig): Promise<void>;
    send(message: OutboundMessage): Promise<void>;
    onMessage(handler: (msg: InboundMessage) => void): void;
    getDMPolicy(): DMPolicy;
  }
  ```
- 安装时按需解析：
  ```typescript
  // src/plugin-sdk/extension-resolver.ts
  export async function resolveExtension(name: string) {
    const pkgName = `@simpleclaw-ext/${name}`;
    try {
      return await import(pkgName);
    } catch {
      throw new Error(
        `扩展 ${name} 未安装。执行: npm install ${pkgName}`
      );
    }
  }
  ```

**预期收益**：安装体积从 670MB → <50MB（无本地模型、无扩展场景）。

---

### 阶段二：架构解耦（P0–P1，预估 4–5 周）

#### 3.2.1 通道适配器 SDK 化

**OpenClaw 现状**：
- 通道逻辑分散在 `src/channels/` 和 `extensions/discord/`, `extensions/telegram/` 等 20+ 处
- 每个适配器重复实现认证、重连、消息格式化

**SimpleClaw 改造**：

创建统一适配器 SDK：
```
src/channel-sdk/
├── index.ts              # 导出接口
├── base-adapter.ts       # 抽象基类（含重连、心跳、日志）
├── message-formatter.ts  # 统一消息格式转换
└── policy.ts             # DM 策略默认实现
```

现有适配器重写为轻量 wrapper（目标每个 <200 行）：
```typescript
// extensions/discord/src/adapter.ts
import { BaseChannelAdapter } from '@simpleclaw/channel-sdk';

export class DiscordAdapter extends BaseChannelAdapter {
  async authenticate(creds: AuthConfig) {
    this.client = new Discord.Client({ intents: [...] });
    await this.client.login(creds.token);
  }

  async send(msg: OutboundMessage) {
    const channel = await this.client.channels.fetch(msg.targetId);
    await channel.send(msg.text);
  }
}
```

#### 3.2.2 Gateway 状态外置

**OpenClaw 现状**：
- `src/gateway/server/`：WebSocket 连接 + 会话状态 + 认证全部在内存
- `src/sessions/`：会话绑定也在内存

**SimpleClaw 改造**：

1. **会话状态迁移至 SQLite**（本地）/ **Redis**（多实例）：
   ```typescript
   // src/gateway/session-store.ts
   export interface SessionStore {
     get(sessionId: string): Promise<SessionState | null>;
     set(sessionId: string, state: SessionState): Promise<void>;
     delete(sessionId: string): Promise<void>;
   }

   // 默认 SQLite 实现（零配置）
   export class SQLiteSessionStore implements SessionStore { ... }

   // Redis 实现（多实例部署时启用）
   export class RedisSessionStore implements SessionStore { ... }
   ```

2. **Gateway 进程只保留**：
   - WebSocket 连接句柄映射（`peerId -> socket`）
   - 事件总线（基于 Redis Pub/Sub 或内置 EventEmitter）
   - 认证与速率限制中间件

3. **Cron 任务拆分**：
   - 从 Gateway 剥离，独立为 `simpleclaw-cron` 进程
   - 通过事件总线与 Gateway 通信

#### 3.2.3 配置一次性迁移

**OpenClaw 现状**：
- `src/compat/` 目录存在，说明有运行时兼容逻辑
- `src/config/` 可能包含新旧键名双轨逻辑

**SimpleClaw 改造**：
- 废弃运行时 `doctor` 修复路径
- 提供 `simpleclaw migrate --from <version>` CLI：
  ```typescript
  // src/cli/migrate.ts
  export async function migrateConfig(fromVersion: string) {
    const migrator = new ConfigMigrator(fromVersion);
    await migrator.run([
      renameKey('old.agent.model', 'models.default'),
      renameKey('channels.telegram.token', 'channels.telegram.auth.token'),
      // ...
    ]);
  }
  ```
- 启动时若检测到旧键名，直接报错并提示执行迁移命令

**预期收益**：Gateway 内存占用从 ~390MB → <100MB。

---

### 阶段三：认知管道重构（P1，预估 5–6 周）

#### 3.3.1 Plan-Review-Execute 三阶段

**OpenClaw 现状**：
- `src/agents/runtime-plan/` 存在但仅做简单任务拆解
- `src/agents/harness/` 直接调度工具，无 Review 拦截点

**SimpleClaw 改造**：

在 Agent Runtime 中强制执行三阶段：

```typescript
// src/agent-runtime/pipeline.ts
export interface AgentPipeline {
  plan(task: UserRequest): Promise<Plan>;
  review(plan: Plan): Promise<ReviewResult>;
  execute(plan: Plan, review: ReviewResult): Promise<ToolOutputStream>;
}

export class StructuredPipeline implements AgentPipeline {
  async plan(task: UserRequest) {
    const planner = this.modelRouter.getPlanner();
    const plan = await planner.generatePlan(task);
    // Plan 必须输出明确的工具调用序列
    plan.validate(); // 不允许边执行边规划
    return plan;
  }

  async review(plan: Plan) {
    if (this.config.reviewMode === 'auto') {
      return new ReviewResult('approved');
    }
    const reviewer = this.modelRouter.getReviewer();
    return await reviewer.review(plan);
  }

  async execute(plan: Plan, review: ReviewResult) {
    if (review.status === 'rejected') {
      throw new PlanRejectedError(review.reason);
    }
    const executor = this.modelRouter.getExecutor();
    // Execute 阶段只读 Plan，不重新解释用户意图
    return executor.run(plan.toolSequence);
  }
}
```

#### 3.3.2 多模型路由

**OpenClaw 现状**：
- `src/model-catalog/` 存在但仅做模型列表管理
- 无按阶段路由能力

**SimpleClaw 改造**：

```json
// simpleclaw.json
{
  "models": {
    "default": "anthropic/claude-sonnet-4",
    "routing": {
      "plan": "anthropic/claude-opus-4",
      "review": "openai/gpt-4o",
      "execute": "anthropic/claude-sonnet-4",
      "qa": "local/llama-3.3-70b"
    }
  }
}
```

```typescript
// src/model-catalog/router.ts
export class ModelRouter {
  getPlanner(): LLMClient { return this.resolve('plan'); }
  getReviewer(): LLMClient { return this.resolve('review'); }
  getExecutor(): LLMClient { return this.resolve('execute'); }

  private resolve(role: string): LLMClient {
    const modelId = this.config.models.routing[role] ?? this.config.models.default;
    return this.catalog.getClient(modelId);
  }
}
```

**成本估算中间件**：
```typescript
// src/agent-runtime/cost-guard.ts
export async function estimateCost(plan: Plan): Promise<CostEstimate> {
  const tokens = plan.estimateTokens();
  if (tokens > this.config.costLimit) {
    throw new CostLimitExceededError(
      `预估消耗 ${tokens} tokens，超出限制。建议拆分任务或降级模型。`
    );
  }
}
```

#### 3.3.3 语义工具路由（LSP 层）

**OpenClaw 现状**：
- `src/agents/tools/` 中使用 keyword matching 路由 edit/read 操作

**SimpleClaw 改造**：
- 集成 `typescript-language-server` 作为可选 LSP 后端
- 工具调用前通过 LSP 获取符号索引
- `edit` / `read` 从 keyword matching 改为符号级定位
- LSP 不可用时 graceful degradation 回退到 keyword matching

**预期收益**：复杂重构任务准确率显著提升；混合路由单次 feature 成本可压至 $2.50–$3.50。

---

### 阶段四：记忆与上下文革新（P1–P2，预估 3–4 周）

#### 3.4.1 分层记忆系统

**OpenClaw 现状**：
- `src/memory/` + `extensions/active-memory/` 双轨并存
- 单文件 MEMORY.md 线性存储

**SimpleClaw 改造**：

树形记忆结构：
```
~/.simpleclaw/workspace/memory/
├── index.md          # 轻量级索引 (~1,500 tokens)
├── people/
│   ├── alice.md
│   └── bob.md
├── projects/
│   ├── project-a.md
│   └── project-b.md
└── facts/
    └── persistent-rules.md
```

```typescript
// src/memory/tree-memory.ts
export class TreeMemory {
  async loadContext(sessionId: string, query: string): Promise<ContextChunk[]> {
    // 1. 始终注入 index.md
    const index = await this.readFile('index.md');
    const chunks = [index];

    // 2. 语义检索相关子文件
    const relevantFiles = await this.semanticSearch(query);
    for (const file of relevantFiles.slice(0, 3)) {
      chunks.push(await this.readFile(file));
    }

    return chunks;
  }
}
```

提供 `/memory index` 命令手动重建索引。

#### 3.4.2 渐进式上下文压缩

三级压缩管道：

| 级别 | 触发条件 | 机制 | 保真度 |
|---|---|---|---|
| **L1: Summarize** | 对话 > 8K tokens | 对话级摘要，保留决策点 | 高 |
| **L2: Index** | 对话 > 32K tokens | 文件操作历史转为符号索引 | 中 |
| **L3: Archive** | 对话 > 64K tokens | 完整对话写入 SQLite，内存只保留元数据 | 低（但可回溯）|

```typescript
// src/context-engine/compression.ts
export class ProgressiveCompressor {
  async compress(context: ConversationContext): Promise<CompressedContext> {
    const tokenCount = await this.estimateTokens(context);
    if (tokenCount > 64_000) return this.archive(context);
    if (tokenCount > 32_000) return this.index(context);
    if (tokenCount > 8_000) return this.summarize(context);
    return context;
  }
}
```

**预期收益**：会话启动 token 减少 ~70%；长会话准确率维持 85%+。

---

### 阶段五：构建与开发循环优化（P2，预估 2 周）

#### 3.5.1 统一构建管道

**OpenClaw 现状**：
- `pnpm openclaw ...`（tsx 直接运行）与 `pnpm build` 双轨
- `pnpm ui:build` 与 Gateway 手动同步

**SimpleClaw 改造**：
- 废弃 tsx 直接运行路径
- 开发模式统一 `pnpm dev`：同时启动 Gateway watch + UI dev server
- 生产构建 `dist/` 包含 UI 静态资源，Gateway 直接 serve

#### 3.5.2 版本号单点管理

- 引入 `changesets` 从根 `package.json` 自动同步版本号到：
  - `apps/android/app/build.gradle.kts`
  - `apps/ios/version.json`
  - `macOS/Info.plist`
- CI 校验：版本号不一致则构建失败

---

## 四、SimpleClaw 目录结构（目标）

```
simpleclaw/
├── src/
│   ├── core/                    # Layer 1: 内核
│   │   ├── protocol.ts
│   │   ├── config-schema.ts
│   │   ├── plugin-loader.ts
│   │   └── logger.ts
│   ├── agent-runtime/           # Layer 2: 编排引擎
│   │   ├── pipeline.ts
│   │   ├── model-router.ts
│   │   ├── tool-registry.ts
│   │   ├── context-assembler.ts
│   │   └── security-policy.ts
│   ├── gateway/                 # Layer 3: 无状态控制平面
│   │   ├── router.ts
│   │   ├── auth.ts
│   │   ├── rate-limit.ts
│   │   ├── event-bus.ts
│   │   └── session-store/
│   │       ├── interface.ts
│   │       ├── sqlite.ts
│   │       └── redis.ts
│   ├── channel-sdk/             # Layer 4 基础设施
│   │   ├── base-adapter.ts
│   │   ├── message-formatter.ts
│   │   └── policy.ts
│   ├── memory/                  # 分层记忆
│   │   ├── tree-memory.ts
│   │   └── semantic-search.ts
│   ├── context-engine/          # 上下文压缩
│   │   └── compression.ts
│   └── cli/
│       ├── migrate.ts
│       ├── setup.ts
│       └── dev.ts
├── extensions/                  # 独立插件（可选安装）
│   ├── discord/
│   ├── telegram/
│   ├── slack/
│   └── ...
├── ui/                          # Control UI
├── dist/                        # 构建产物
├── simpleclaw.json              # 主配置
└── package.json
```

---

## 五、安全与兼容性底线

| 红线 | 措施 |
|---|---|
| **权限模型保守** | Execute 阶段继承 `per-action approval`，Review 阶段增加安全策略校验 |
| **向前兼容窗口** | 迁移 CLI 保留 2 个主版本，之后彻底废弃旧键名 |
| **插件 API 稳定** | Layer 1 Core 接口遵循 SemVer，避免社区插件失效 |

---

## 六、预期收益总览

| 指标 | OpenClaw 现状 | SimpleClaw 目标 | 实现阶段 |
|---|---|---|---|
| 安装体积 | 670MB | <50MB（无本地模型/扩展） | 阶段一 |
| 核心代码量 | 13,300+ 文件 | <500 文件（核心）+ 插件 | 阶段二 |
| Gateway 内存 | ~390MB | <100MB | 阶段二 |
| 会话启动 token | 5K–10K | <1.5K | 阶段四 |
| 长会话准确率 | 60–70% @ 110K | 85%+ @ 100K | 阶段四 |
| 混合路由成本 | $9.15/feature | $2.50–$3.50/feature | 阶段三 |
| 安全防御率 | 17% | >80%（Review 拦截） | 阶段三 |

---

## 七、立即开始的第一步

如果你确认方案方向，建议按以下顺序启动：

1. **初始化 SimpleClaw 仓库结构**（`src/core/`, `src/gateway/`, `src/agent-runtime/` 骨架）
2. **从 `node-llama-cpp` 懒加载改造开始**（改动最小、收益最直接）
3. **同步将 `extensions/` 中的 1-2 个通道适配器提取为独立包**，验证 SDK 接口设计

请确认是否按此方案推进，或需要调整某些阶段的优先级/范围。
