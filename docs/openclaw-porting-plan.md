# SimpleClaw ← OpenClaw 能力移植计划

## 核心策略："偷设计，不偷代码"

OpenClaw 用 Effect-ts + Bun + Drizzle，SimpleClaw 用纯 TS + Node。不要移植实现细节，只移植**设计模式**。

---

## Phase 0: 止血（必须先修）

### 0.1 System Prompt 效力不足
**现状**：虽然加了 "Do NOT call ls/read/edit for general knowledge"，模型仍然会调用工具。

**根因**：规则放在 TOOLS slot 里，被工具描述淹没。模型看到 `web_search` 说 "Use this for current information"，然后看到 `bash` 说 "Execute local shell"，但没说 "bash 不能 curl"。

**修复**：在 **PROTOCOL slot 最顶部** 加一条铁律（模型最先看到）：
```
=== TOOL SELECTION RULE ===
Before calling ANY tool, ask yourself: "Does this task require reading or modifying files?"
- If YES → use read/edit/ls/grep/bash as needed.
- If NO → answer directly. Do NOT call any tool.
```

### 0.2 web_search 鲁棒性
**现状**：Bing HTML 解析脆弱，一旦页面结构变化就失败。

**修复**：加 fallback 搜索引擎（Baidu/Sogou），或者直接用 SearXNG 实例。

---

## Phase 1: Instruction 系统（1 天，收益最大）

### 目标
让 Agent 自动读取项目里的 `AGENTS.md` / `CLAUDE.md`，注入 system prompt。

### 设计（复制 OpenClaw）
```
扫描路径（按优先级，第一个匹配即停）:
  1. {workspace}/AGENTS.md
  2. {workspace}/CLAUDE.md
  3. ~/.simpleclaw/AGENTS.md
```

### 代码改动
- 新增 `src/agent-runtime/instruction-loader.ts`
- `AgentEngine.buildSystemPrompt()` 在 PROTOCOL 之后注入 instructions
- 只在**首次 turn** 加载（避免重复注入）

### 为什么先做它
- 零新增概念，复用现有文件
- 立即提升 Agent 对项目上下文的理解
- 为后续 Skill 系统打基础（Skill 也是 markdown 文件加载）

---

## Phase 2: Skill 系统（2-3 天，核心）

### 目标
实现 OpenClaw 的**渐进式 Skill 披露**：Agent 看到技能列表 → 主动调用 `skill` 工具 → 加载工作流指令。

### 设计（简化版）

**文件结构：**
```
skills/
├── data-analysis/
│   └── SKILL.md      # YAML frontmatter + Markdown workflow
├── code-review/
│   └── SKILL.md
└── ...
```

**Skill 文件格式：**
```markdown
---
name: data-analysis
description: Analyze spreadsheets, CSVs, or tabular data
triggers: ["分析", "csv", "excel", "chart"]
---

## Workflow
1. Clarify → 2. Execute → 3. Verify

## Gate
Do NOT start until you know the data source and output format.
```

**加载来源：**
```
1. {workspace}/skills/*/SKILL.md          (项目级)
2. ~/.simpleclaw/skills/*/SKILL.md        (用户级)
3. 内置 skills (simpleclaw 包内)           (内置)
```

**System Prompt 注入（Phase 1 风格）：**
```
=== AVAILABLE SKILLS ===
Use the `skill` tool to load a skill when the task matches its description.

- data-analysis: Analyze spreadsheets, CSVs, or tabular data
- code-review: Review code for bugs, style, and architecture
```

**`skill` 工具：**
```typescript
name: "skill"
description: "Load a specialized skill into the conversation. Use when the task matches one of the available skills listed above."
parameters: { name: string }
execute: (name) => {
  const skill = findSkill(name);
  return skill.content;  // 注入工作流指令
}
```

### 关键设计决策

**Q: Skill 是自动注入还是 Agent 主动加载？**
A: **主动加载**（Copy OpenClaw）。原因：
- 避免无关 skill 污染上下文
- 让 Agent 学会"选择工具"
- Skill 内容可能很长（几百行），全部注入会爆 token

**Q: 加载后的 Skill 内容放在哪里？**
A: 作为 **assistant message** 追加到对话历史中（或作为额外的 system message）。这样 compaction 时会自然被保留或压缩。

**Q: 如何防止 Skill 被 compaction 误删？**
A: Phase 3 再处理。Phase 2 先跑起来。

### 代码改动
- 新增 `src/agent-runtime/skill/skill-loader.ts` — 扫描 + 解析 + 缓存
- 新增 `src/agent-runtime/skill/skill-tool.ts` — `skill` 工具实现
- 修改 `AgentEngine.buildSystemPrompt()` — 注入 available_skills 列表
- 修改 `src/core/config-schema.ts` — 支持 `skillsDir` 配置

---

## Phase 3: 结构化 Compaction（1-2 天）

### 目标
替换现在的简单摘要，用 OpenClaw 的**锚定式结构化模板**。

### OpenClaw 模板
```markdown
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
```

### 为什么这个模板好
- **机器可读**：LLM 看到结构化内容，恢复上下文更容易
- **用户可读**：summary 本身就是一份进度报告
- **锚定**：固定 section 顺序，LLM 知道去哪里找什么信息

### 代码改动
- 修改 `src/core/compactor.ts` — 替换摘要生成逻辑
- 修改 `ContextCompactorConfig` — 添加 `template` 选项

---

## Phase 4: 多 Agent Preset（可选，2 天）

### 目标
内置 `explore` / `coder` / `tester` 角色，每个有独立的 prompt 和权限。

### 设计（比 OpenClaw 简化）
```typescript
// config-schema.ts
agents: [
  {
    id: "default",
    name: "Default",
    prompt: "You are a helpful assistant...",
    tools: ["read", "edit", "bash", "web_search", ...],
  },
  {
    id: "explore",
    name: "Explore",
    prompt: "You are a research specialist...",
    tools: ["read", "grep", "glob", "web_search"],  // 无 edit
    denyTools: ["edit", "write"],
  }
]
```

### 代码改动
- `AgentConfigSchema` 支持 `agents` 数组
- `AgentEngine` 根据 `agentId` 选择 prompt 和工具白名单
- `spawn` 工具支持 `role` 参数映射到 preset

---

## 关键架构决策

### Decision 1: Skill ≠ Memory
- **Skill** = 工作流模板（教 Agent "怎么做事"）
- **Memory** = 项目知识（教 Agent "项目里有什么"）
- 两者完全独立，不要混为一谈

### Decision 2: Skill 加载 = 工具调用
- 不要自动注入所有 skill
- Agent 必须显式调用 `skill` 工具
- 这是"渐进式披露"的核心

### Decision 3: Instruction 优先于 Skill
- `AGENTS.md` 是项目基线，每次对话都加载
- Skill 是场景增强，按需加载
- 这样避免 Skill 和 Instruction 冲突

### Decision 4: 不移植 Effect-ts
- OpenClaw 用 Effect-ts 做错误处理和并发
- SimpleClaw 保持 async/await + try/catch
- 只移植业务逻辑，不移植运行时框架

---

## 推荐执行顺序

```
Week 1
├── Day 1-2: Phase 0（止血）+ Phase 1（Instruction）
├── Day 3-5: Phase 2（Skill 系统核心）

Week 2
├── Day 1-2: Phase 3（结构化 Compaction）
├── Day 3-5: Phase 4（多 Agent Preset，可选）
```

先做 **Phase 1（Instruction）**，因为它：
1. 代码量最小（~100 行）
2. 立即提升体验（Agent 读懂项目规范）
3. 为 Phase 2 的 Skill 扫描打基础
