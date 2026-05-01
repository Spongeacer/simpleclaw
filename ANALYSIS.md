# OpenClaw 代码结构分析：内核、周边与 MVP 价值

> 基于 `openclaw/openclaw@main` (2026.4.27) 实际源码的逆向工程分析。

---

## 一、总体规模

| 区域 | 文件数 | 说明 |
|---|---|---|
| `src/` | 7,482 TS 文件 | 核心运行时，50+ 子模块 |
| `extensions/` | 5,380 TS 文件 / **125 目录** | 通道、模型提供商、工具扩展 |
| `ui/` | 317 TS/TSX 文件 | Control UI |
| `apps/` | Android / iOS / macOS | 原生客户端 |
| `package.json` | 91KB / 1,715 行 | 依赖与导出爆炸 |

---

## 二、内核边界（不可替代的最小集合）

### 2.1 Layer 1：基础设施内核

这些模块被引用次数最多，是整个系统的地基。精简时**不能动**，只能瘦身接口。

| 模块 | 被引用次数 | 职责 | 精简策略 |
|---|---|---|---|
| `src/config/` | **1,903** | 配置解析、Schema 验证、会话存储 | 保留 Schema 和解析器，废弃运行时 `doctor` 修复 |
| `src/infra/` | **1,128** | 进程管理、文件系统抽象、网络层 | 保留核心抽象，剥离具体后端 |
| `src/shared/` | **859** | 通用工具函数、类型定义 | 保留被高频使用的子集 |
| `src/logging/` | **162** | 日志系统 | 保留，但可简化输出格式 |
| `src/plugin-sdk/` | **918** (plugins) | 插件合约、类型定义、注册表 | **必须保留并稳定化**，这是扩展生态的基石 |
| `src/gateway/protocol/` | — | JSON-RPC 协议帧格式、Ajv Schema、错误码 | 纯描述层，是所有通信的语法基础 |

### 2.2 Layer 2：Agent Runtime 心脏

这是 OpenClaw 最不可替代的部分。`pi-embedded-runner` 是一个 2,471 行的 `while(true)` 大循环，承载了全部智能。

| 模块 | 职责 | 是否内核 | 理由 |
|---|---|---|---|
| `src/agents/pi-embedded-runner/run.ts` | **核心执行循环**：LLM 调用 → tool call → 结果回传 → retry/failover/compaction | **是** | 这是 Agent 的心脏，没有它就没有智能 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 单次尝试的模型推理 + 工具调用分发 | **是** | 被 `run.ts` 直接调用 |
| `src/agents/harness/` | Harness 注册表 + 选择器（PI 内置 / 插件） | **是** | 即使只保留 PI 内置 harness，也需要选择逻辑 |
| `src/agents/runtime-plan/build.ts` | 运行时配置组装器（auth + prompt + tools + transcript + delivery） | **是** | 被 `run.ts` 直接依赖 |
| `src/agents/sandbox/` | 安全基座：Docker/SSH 后端、FS 桥接、路径安全检查、工具策略 | **是** | 没有 sandbox，dangerous 命令无法安全执行 |
| `src/agents/bash-tools.exec-approval-request.ts` | **权限确认机制**：向 Gateway 注册审批请求并等待用户决策 | **是** | 安全红线，不可移除 |
| `src/agents/command/attempt-execution.ts` | 上层命令到底层 PI runner 的桥梁 | **是** | 入口函数 |

### 2.3 Layer 3：Gateway 最小骨架

当前 Gateway 是一个**重度有状态单体**。要实现无状态化，最小保留集如下：

| 模块 | 职责 | 无状态化策略 |
|---|---|---|
| `src/gateway/protocol/` | 协议定义 | 原样保留 |
| `src/gateway/server/http-listen.ts` | HTTP 监听 | 保留，剥离 TLS/HTTP2 等高级特性 |
| `src/gateway/server/ws-connection.ts` | WebSocket 连接 | **精简**：只保留 `peerId → socket` 映射，移除 `clients` 集合、presence、广播 |
| `src/gateway/auth.ts` + `auth-rate-limit.ts` | 认证 + 限流 | 保留逻辑，但限流状态从内存 Map 迁移到 Redis/SQLite |
| `src/gateway/server-methods/connect.ts` | 握手/角色校验 | 保留，改为无状态 token 校验 |
| `src/gateway/server-methods/chat.ts` | `chat.send` 核心推理 | 保留 RPC 门面，实际推理委托给 Agent Runtime |
| `src/gateway/server-methods/send.ts` | 消息发送委托 | 保留 RPC 门面，投递委托给通道扩展 |

### 2.4 内核依赖关系图

```
config (1903 refs)
  ├── infra (1128 refs)
  ├── shared (859 refs)
  ├── logging (162 refs)
  └── plugins/sdk (918 refs)
        ├── gateway/protocol ──→ server-methods/chat
        │                          └── agents/command/attempt-execution
        │                                └── agents/harness/selection
        │                                      └── agents/pi-embedded-runner/run.ts
        │                                            ├── runtime-plan/build.ts
        │                                            ├── sandbox/fs-bridge.ts
        │                                            └── bash-tools.exec-approval-request.ts
        └── extensions/* (按需加载)
```

---

## 三、周边清单（可剥离或降级）

### 3.1 extensions/ — 125 个扩展，全部可插件化

| 类型 | 数量 | 代表 | 剥离策略 |
|---|---|---|---|
| **通道适配器** | 30 | discord, telegram, slack, whatsapp, signal... | 全部移出核心，改为 `@simpleclaw-ext/channel-discord` 等独立包 |
| **模型提供商** | 61 | anthropic, openai, deepseek, ollama, lmstudio... | 只保留 2-3 个主流（anthropic/openai），其余移出 |
| **工具扩展** | 24 | browser, web-search, image-gen, video-gen, tts... | 移出核心，按需安装 |
| **其他** | 10 | diagnostics, migrate, test-support... | 全部移出 |

**关键发现**：根目录 `package.json` 的 `dependencies` 中**没有**任何通道库（如 `discord.js`、`grammy`）。通道库全在 extension 级别管理。这说明 OpenClaw 作者已经意识到了解耦的必要性，但扩展仍然和核心在同一个 monorepo 中构建，导致安装体积失控。

### 3.2 src/ 内部可剥离模块

| 模块 | 当前文件数 | 剥离理由 | MVP 是否需要 |
|---|---|---|---|
| `src/canvas-host/` | — | 实时 Canvas 渲染，独立 HTTP 服务 | 否 |
| `src/realtime-voice/` | — | 实时语音对话 | 否 |
| `src/realtime-transcription/` | — | 实时语音转文字 | 否 |
| `src/tts/` | — | 文本转语音 | 否 |
| `src/image-generation/` | — | 图片生成 | 否 |
| `src/music-generation/` | — | 音乐生成 | 否 |
| `src/video-generation/` | — | 视频生成 | 否 |
| `src/media-generation/` | — | 媒体生成统一层 | 否 |
| `src/media-understanding/` | — | 媒体理解 | 否 |
| `src/web-search/` | — | 网络搜索 | 可选 |
| `src/web-fetch/` | — | 网页抓取 | 可选 |
| `src/cron/` | — | 定时任务调度 | 否 |
| `src/daemon/` | — | 守护进程管理 | 否 |
| `src/pairing/` | — | 设备配对 | 否 |
| `src/status/` | — | 状态报告 | 否 |
| `src/trajectory/` | — | 轨迹追踪 | 否 |
| `src/tui/` | — | 终端 UI | 否 |
| `src/wizard/` | — | 安装向导 | 否 |
| `src/i18n/` | — | 国际化 | 否（先英文） |
| `src/auto-reply/` | — | 自动回复规则引擎 | 否 |
| `src/compat/` | — | 兼容性垫片（新旧键名双轨） | **阶段二废弃** |
| `src/agents/tools/` (业务工具) | 50+ | image-gen, music-gen, web-search, canvas, tts... | 只保留 `read`/`edit`/`shell` 基座 |

### 3.3 Gateway 内部可剥离功能

| 功能 | 剥离理由 |
|---|---|
| `server-channels.ts` 的 start/stop 循环 | 通道生命周期管理是重度有状态逻辑 |
| `node-registry` / 设备配对 | 边缘节点管控，非核心网关必需 |
| Canvas Host | 独立 sidecar |
| Control UI (`control-ui.ts`) | 静态面板，独立前端 |
| Cron 服务 (`server-cron.ts`) | 交给外部调度器 |
| 插件 HTTP 路由 (`plugins-http.ts`) | 扩展路由由 sidecar/ingress 处理 |
| Bonjour / Tailscale 网络发现 | 下沉到基础设施 |
| 语音唤醒 / Talk | 独立服务 |
| 更新检查 / 技能管理 | 运维功能 |
| 内存去重缓存 (`dedupe`) | 无状态后由客户端幂等键或外部缓存承担 |
| 会话事件订阅广播 | 无长连接后无需内存订阅表 |

---

## 四、MVP 价值判断：SimpleClaw 0.1 应该保留什么

### 4.1 MVP 定义

> 一个**能安全运行、能编辑代码、能对话、能接入至少一个通道**的最小可运行系统。

### 4.2 MVP 保留清单（预估 <800 文件）

#### A. 内核地基（~200 文件）

```
src/core/
├── config/              # 配置解析（精简版，移除 doctor/compat）
├── infra/               # 进程/FS/网络抽象（精简版）
├── shared/              # 通用工具（按需保留）
├── logging/             # 日志
├── types/               # 全局类型
└── protocol/            # 协议定义（从 gateway/protocol 提取）
```

#### B. Agent Runtime 心脏（~300 文件）

```
src/agent-runtime/
├── runner/
│   ├── loop.ts          # 核心 while 循环（从 pi-embedded-runner/run.ts 提取）
│   ├── attempt.ts       # 单次尝试
│   └── backend.ts       # 后端抽象
├── harness/
│   ├── builtin.ts       # 内置 harness
│   └── selection.ts     # 选择器
├── plan/
│   └── builder.ts       # 运行时配置组装
├── sandbox/
│   ├── backend.ts       # 沙箱后端注册表
│   ├── docker-backend.ts
│   ├── fs-bridge.ts
│   ├── fs-bridge-path-safety.ts
│   ├── validate-sandbox-security.ts
│   └── tool-policy.ts
├── security/
│   └── approval.ts      # 权限确认（从 bash-tools.exec-approval-request 提取）
├── auth/
│   └── profiles.ts      # 认证配置
└── failover.ts          # 模型故障转移
```

#### C. Gateway 无状态骨架（~150 文件）

```
src/gateway/
├── protocol/            # 协议帧格式
├── server/
│   ├── http.ts          # HTTP 监听（精简）
│   └── ws.ts            # WS 连接（精简，无广播）
├── auth/
│   ├── auth.ts
│   └── rate-limit.ts    # 限流（SQLite/Redis 后端）
└── methods/
    ├── connect.ts
    ├── chat.ts
    └── send.ts
```

#### D. 通道 SDK + 一个示例适配器（~100 文件）

```
src/channel-sdk/
├── interface.ts         # ChannelAdapter 接口
├── base-adapter.ts      # 抽象基类
└── message-formatter.ts

extensions/cli-channel/  # 或 stdio-channel，作为 MVP 的默认通道
├── adapter.ts
└── package.json
```

#### E. 记忆系统最小版（~50 文件）

```
src/memory/
├── tree-store.ts        # 树形文件存储
├── index.ts             # 索引管理
└── semantic-search.ts   # 简单语义检索（基于 sqlite-vec）
```

### 4.3 MVP 明确不做的功能

| 功能 | 不做理由 |
|---|---|
| 30+ 通道适配器 | 只保留 CLI/stdio 一个通道 |
| 60+ 模型提供商 | 只保留 Anthropic + OpenAI |
| 图片/音乐/视频生成 | 非代码 Agent 核心 |
| 实时语音 | 独立服务 |
| Canvas Host | 独立服务 |
| 原生 App（Android/iOS/macOS） | 后期再考虑 |
| Control UI | CLI 配置即可 |
| Cron | 外部调度器 |
| 设备配对 / 多节点 | 单实例运行 |
| 国际化 | 先英文 |

### 4.4 MVP 代码量预估

| 区域 | 预估文件数 | 占比 |
|---|---|---|
| 内核地基 | ~200 | 2.7% |
| Agent Runtime | ~300 | 4.0% |
| Gateway | ~150 | 2.0% |
| 通道 SDK + 示例 | ~100 | 1.3% |
| 记忆系统 | ~50 | 0.7% |
| **MVP 合计** | **~800** | **10.7%** |
| OpenClaw 原始 src/ | 7,482 | 100% |

---

## 五、关键发现与结论

### 5.1 三个反直觉的发现

1. **OpenClaw 作者已经在做解耦，但没做到位**
   - 根 `package.json` 中没有通道库，说明通道依赖已被下放到 extension 级别
   - 但 125 个扩展仍然和核心在同一个 monorepo 中构建，发布时全量打包
   - 这解释了为什么安装体积 670MB：不是依赖写错了位置，而是**构建管道没有做按需打包**

2. **Agent Runtime 的核心不是 "plan"，而是一个大 while 循环**
   - `runtime-plan/` 不是"规划阶段"，而是**运行时配置组装器**
   - 真正的智能在 `pi-embedded-runner/run.ts` 的 2,471 行 `while(true)` 中
   - 要做 Plan-Review-Execute 三阶段，不是"加个 review 模块"，而是**重构这个核心循环**

3. **Gateway 的"无状态化"最大障碍不是代码量，而是架构模式**
   - Gateway 代码量其实不大（4 个目录，~200 文件被引用）
   - 但它是**重度有状态单体**：内存 Map 管理连接、订阅、去重、限流
   - 无状态化 = 把这些内存 Map 替换为外部存储（SQLite/Redis），而非删除文件

### 5.2 实施优先级建议（基于 MVP）

```
Phase 0: 脚手架（1 周）
  └── 创建 SimpleClaw 目录结构
  └── 从 OpenClaw 提取内核地基（config/infra/shared/logging/types/protocol）

Phase 1: Agent 心脏移植（2-3 周）
  └── 提取 pi-embedded-runner 核心循环
  └── 精简 sandbox + approval 机制
  └── 只保留 read/edit/shell 工具基座

Phase 2: Gateway 无状态化（1-2 周）
  └── 保留 protocol + http/ws 骨架
  └── 会话存储从文件 JSON 改为 SQLite
  └── 限流从内存 Map 改为 SQLite

Phase 3: 通道 SDK 化（1 周）
  └── 定义 ChannelAdapter 接口
  └── 实现 CLI/stdio 适配器作为示例
  └── 验证插件加载机制

Phase 4: 记忆树形化（1 周）
  └── 替换 MEMORY.md 为树形存储
  └── 实现 index.md + 按需加载

MVP 发布 → 再逐步添加多模型路由、Plan-Review-Execute、更多通道...
```

---

## 六、下一步决策点

请确认以下判断是否符合你的预期：

1. **MVP 只保留 CLI/stdio 通道**，先做"终端里的 AI 助手"，后期再添加 Discord/Slack 等
2. **模型提供商只保留 Anthropic + OpenAI**，其余后期通过 `@simpleclaw-ext/provider-xxx` 添加
3. **安全机制（sandbox + approval）在 MVP 中就保留**，不做妥协
4. **Plan-Review-Execute 三阶段不在 MVP 中实现**，先把核心循环跑通，0.2 版本再加入认知分层

如果以上方向确认，我们可以立即开始 **Phase 0：脚手架搭建**。
