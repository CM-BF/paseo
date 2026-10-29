---
title: 在 SDK 中使用 Agent
description: 用 TypeScript 创建、运行、查找、复用、设置父级和归档编程 Agent。
nav: Agent
---

# 在 SDK 中使用 Agent {#agents-with-the-sdk}

Agent 句柄持有一个稳定的 Agent ID，并在不暴露 daemon RPC 的情况下提供每一轮的生命周期。

## 运行初始提示词 {#run-an-initial-prompt}

```ts
const agent = await client.agents.create({
  config: {
    provider: "claude/claude-sonnet-5",
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the checkout flow and propose one focused fix.",
  labels: { source: "checkout-review" },
});

const result = await agent.waitForFinish();
console.log(result.status, result.lastMessage);
```

`waitForFinish()` 返回以下四种状态之一：

| 状态         | 含义                                     |
| ------------ | ---------------------------------------- |
| `idle`       | 本轮已完成，Agent 可以接收下一条提示词。 |
| `permission` | Agent 需要有人在 Paseo 中回应权限请求。  |
| `error`      | Provider 以错误结束了本轮。              |
| `timeout`    | 已超过等待截止时间；Agent 可能仍在运行。 |

超时不会取消 Agent。

## 查询创建结果，避免重发首条输入 {#recover-a-creation-without-resending}

派工前持久保存创建 key、agentId、clientMessageId 和完整输入。新建会话需要独占首次派工时，
在 `agents.create()` 中传 `requireInitialPromptReservation: true`；旧主机不支持
`creationInitialPrompt` 时会在创建前拒绝。主机会从新会话公开前一直保留准入到首次原生 turn
受理，期间拒绝其他 Paseo 入口的发送、后台命令、重载与生命周期修改。此保证只覆盖 Paseo
管理的入口，不隔离任意外部 provider 客户端。首次受理后正常使用工具和权限交互，goals 与协作保留。

重连或进程重启后使用只读查询：

```ts
const receipt = await client.creations.get({
  kind: "agent", // 工作区连同初始 agent 一起创建时为 "workspace"
  idempotencyKey: savedCreationKey,
});
if (receipt?.initialPrompt?.status === "accepted") {
  console.log(receipt.agentId, receipt.initialPrompt.turnId);
}
```

`phase: "completed"` 只证明创建完成。`initialPrompt` 独立记录首条输入：

| 状态          | 含义                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `pending`     | 还在准备或等待原生首次启动结果。                                                                 |
| `accepted`    | provider 已受理输入；`turnId` 是 Paseo 前台轮次身份，不是执行完成，也不是 provider 协议原始 ID。 |
| `not_sent`    | 准备阶段失败，尚未尝试原生派工。                                                                 |
| `unknown`     | 可能已经受理，不自动重发或另建替代会话。                                                         |
| `out_of_band` | 已交给后台命令处理器，不声称创建了 foreground turn。                                             |

查不到记录、旧记录缺少 `initialPrompt`，都不能证明从未执行。首轮受理后 SessionStart hook
失败仍是该轮执行失败，创建回执保留确切身份；从原生历史和权限面板核对。重放已完成或不确定的
创建 key 不会重发首条输入。`creations.get()` 在记录不存在时也不会创建或发送。
资源被删除后，查询仍保留历史回执，并用 `resources.status: "unavailable"` 与错误说明当前不可用；
回执中的 agent 快照是历史记录，当前状态需刷新 agent。无 prompt 创建后另行发送不在此保留范围内。

每个后台输入使用这条路径会创建不同的原生会话；共享上下文要明确传入，结果绑定各次执行的
agent 和 turn，界面不能声称它们是同一原生连续会话。此能力没有补齐 provider 自主后续轮次的精确取消。

## 为后续提示词保持会话 {#keep-a-session-alive-for-follow-ups}

当提示词稍后才会到来时，创建一个空闲的会话：

```ts
const reviewer = await client.agents.create({
  config: {
    provider: "codex/gpt-5.5",
  },
  cwd: "/Users/me/dev/storefront",
  title: "Checkout reviewer",
});

const first = await reviewer.run("Review the current diff.");

if (first.status === "idle") {
  const second = await reviewer.run("Now focus on failure recovery.");
  console.log(second.lastMessage);
}
```

只管发送、不关心结果时使用 `send()`。调用方需要该轮的结果时使用 `run()`。

如果补充指令只属于刚才观察到的轮次，使用 `steer()`：

```ts
await reviewer.refresh();
const turn = reviewer.activeTurn;
if (turn) {
  const result = await reviewer.steer("Also check the rollback path.", {
    expectedTurnId: turn.turnId,
    messageId: `review-rollback-${turn.turnId}`,
  });
  console.log(result.status); // accepted, unavailable, or changed
}
```

主机需要支持 `agentTurnSteer`。daemon 会在实际发送时再次核对 Paseo 轮次 ID。
`changed` 表示目标轮次已不再运行；`unavailable` 表示 Provider 无法接收追加指令。
两者都不会启动或中断轮次，也不会清除待处理的权限请求。`accepted` 只确认指令已送达，
不代表任务完成。响应丢失后，使用相同的 `messageId`、文本和 `expectedTurnId` 重试，
即可读取已保存的结果。`agent_request_outcome_unknown` 表示无法确认是否送达，
此时不要换一个消息 ID 自动重发。仅在调用方不需要恢复重试时省略 `messageId`。

## 仅在空闲时发送 {#send-only-when-idle}

任务队列需要避免干扰其他调用方的轮次时，使用 `sendIfIdle()`：

```ts
const result = await reviewer.sendIfIdle("Run the next queued check.", {
  messageId: "queue-check-42",
});
if (result.status === "accepted") console.log(result.turnId);
```

daemon 预留前台轮次后，还要求 provider 在原生会话层原子检查空闲并启动。`busy` 表示没有发送
输入；正在运行或启动、等待替换、存在未处理权限时不可接收。`unavailable` 同样表示未发送，
原因是 provider 无法保证原生空闲准入。此方法不会引导、中断、清除权限或取消归档；已归档的
Agent 在准备阶段被拒绝。主机支持 `agentSendIfIdle` 不代表 provider 支持。当前生产 provider
（包括 Codex）均未实现该原生保证；Codex 普通启动可能追加到原生自动轮次，因此不会回退调用它。

`accepted` 返回实际轮次 ID，只确认已启动，不代表任务完成。响应丢失时，用同样的文本和消息
ID 重试，`accepted`、`busy` 和 `unavailable` 均返回原先持久保存的结果。明确未发送后，下次
重新尝试派工需用新消息 ID；结果不确定时不能换 ID 自动重发。

## 按标签查找 Agent {#find-agents-by-label}

创建时设置 `labels`，之后按标签过滤。匹配由 daemon 完成：

```ts
const page = await client.agents.list({
  filter: { labels: { "issue-provider": "my-tracker" } },
});

for (const { agent } of page.entries) {
  console.log(agent.id, agent.title, agent.status);
}
```

## 通过 ID 继续 Agent {#continue-an-agent-by-id}

```ts
const agent = client.agents.ref("agent_01H8X...");

const result = await agent.run("Now write the fix.");
console.log(result.lastMessage);
```

`ref()` 不会联系 daemon。当你需要知道 Agent 是否仍然存在时，先调用 `refresh()`；如果不存在，它返回 `null`。

## 更新会话指令 {#update-session-instructions}

在会话空闲时更新长期角色指令，不需要换一个 Agent 或重新发送历史：

```ts
const snapshot = await agent.updateInstructions({
  systemPrompt: "You review checkout changes. Explain risks before suggesting edits.",
  // 省略 mcpServers 保留当前工具配置。
});
console.log(snapshot.id);
```

创建时可用 `config.skillMounts: [{ directory: "/绝对路径/plugin-data/projection" }]`
挂载原生技能，也可通过同一个空闲 `updateInstructions` 操作替换。需要主机能力
`nativeSkillMounts`；旧主机在请求发送前被拒绝。省略保留已有挂载，更新时传 `[]` 清除。
更新仍需传入完整 `systemPrompt`。

插件可能自带旧 SDK。必须在执行创建或更新的**同一个 API 实例**上检测公开方法；
旧版本内置 schema 可能静默移除未知字段：

```ts
if (
  typeof client.agents.supportsNativeSkillMounts !== "function" ||
  !client.agents.supportsNativeSkillMounts()
) {
  throw new Error("请升级 SDK 并连接支持原生技能挂载的主机。");
}
```

该方法读取此连接真实声明的能力，断线时返回 false。宿主注入的 `context.paseo` 与插件
自带的 Node client 是两个 API 实例，不能用前者的结果证明后者支持新字段。
返回 true 代表宿主支持，Provider 与原生 catalog 仍在实际使用时验证。

投影目录包含 `skills/<名称>/SKILL.md` 和 `.claude-plugin/plugin.json`，清单只允许
`name`、可选的 `version` 与 `description`。拒绝 hooks、agents、commands、MCP/LSP 配置、
非标准技能文件名以及清单/技能根目录逃逸出投影的符号链接。目录应放在持久插件数据中，不能依赖升级时会
清理的 checkout。挂载保留原资源与权限，不自动批准工具，也不替换用户和项目已有技能。

Codex 在该 agent 独立的 app-server 进程内设置目录，并在启动/恢复 thread 前检查真实
catalog。同进程的原生子代理共享这些技能，其他 Paseo agent 不共享配置。Claude 使用
会话级本地插件并关闭其 MCP 发现。目录缺失、Codex 未发现指定技能或 provider 不支持时
会明确失败。恢复运行时会重新挂载，不写全局 provider home。路径引用不是内容快照；
两个 agent 显式挂载同一可变目录时共享其文件。catalog 可见不代表模型已实际读取或执行技能。

等待调用成功后再把应用中的角色设置标为“已应用”。daemon 会保留同一持久会话和时间线，拒绝正在运行、等待权限或仍有活动子 Agent 的情况，不会自动打断它们。此操作会重启 Provider 运行时，不能保证保留 Provider 未报告的后台任务。失败原因和恢复方式见[API 参考](./reference.md#agent-handle)。

## 创建子 Agent {#create-a-subagent}

通过工作区创建子 Agent。句柄负责位置，因此调用方无需重复提供目录：

```ts
if (!parent.workspaceId) throw new Error("Parent has no workspace");

const workspace = client.workspaces.ref(parent.workspaceId);
const child = await workspace.agents.create({
  config: {
    provider: "codex/gpt-5.5",
  },
  parent,
  title: "Implement checkout fix",
  prompt: "Implement the accepted checkout plan and run focused tests.",
});
```

`parent` 建立父子关系。归档父 Agent 会级联归档它的子 Agent。如果子 Agent 应该独立继续，请先调用 `detach()`。

## 在后台工作区中运行工作 {#run-work-in-a-background-workspace}

在一次调用中创建一个后台工作区及其第一个 Agent。把 `background` 放在工作区选项中，把 Agent 的配置放在 `agent` 下：

```ts
const cwd = "/Users/me/dev/storefront";
const workspace = await client.workspaces.create({
  source: { kind: "directory", path: cwd },
  background: true,
  agent: {
    cwd,
    config: { provider: "codex/gpt-5.5" },
    prompt: "Review the checkout flow.",
  },
});
```

该调用返回一个工作区句柄，并用提供的提示词启动它的第一个 Agent。

后台 Agent 会保留历史记录，并在 daemon 重启后继续存在。默认的发现结果会隐藏它们；使用 `client.agents.list({ filter: { includeBackground: true } })` 可以包含它们。精确 ID 的句柄可以正常使用。默认值和调用方继承规则见[创建工作区](./workspaces.md#create-a-fresh-workspace)。

## 请求结构化输出 {#request-structured-output}

```ts
const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["summary", "risk"],
  additionalProperties: false,
};

const agent = await client.agents.create({
  config: {
    provider: "codex/gpt-5.5",
  },
  cwd: "/Users/me/dev/storefront",
  outputSchema: schema,
  prompt: "Assess the release risk of the current diff.",
});

const result = await agent.waitForFinish();
if (result.status !== "idle" || !result.lastMessage) {
  throw new Error(result.error ?? "Agent returned no structured output");
}

const assessment = JSON.parse(result.lastMessage) as {
  summary: string;
  risk: "low" | "medium" | "high";
};
```

在把解析出的值作为可信输入使用之前，请在你的应用中校验它。

## 读取 Agent 的当前状态 {#read-the-current-state-of-an-agent}

```ts
const agent = client.agents.ref("agent_01H8X...");
await agent.refresh();

if (agent.pendingPermissions?.length) {
  console.log(`Waiting on ${agent.pendingPermissions.length} permission request(s)`);
}
console.log(agent.lastUsage?.totalCostUsd, agent.runtimeInfo?.sessionId);
```

句柄以属性的形式提供 `status`、`capabilities`、`availableModes`、`pendingPermissions`、`activeTurn`、`lastUsage`、`lastError`、`features`、`runtimeInfo`、`archivedAt`、`workspaceId` 和 `cwd`。它们读取的都是句柄最近观察到的快照，从不发起请求。

`ref()` 返回的句柄还没有观察到任何内容，因此在 `refresh()`、`run()`、`waitForFinish()`、时间线重新获取或 `subscribe()` 投递快照之前，这些属性都是 `null`。已观察到的快照中的可选值也读作 `null`。当你需要整个快照，或需要区分这些状态时，请使用 `current()`。

`subscribe()` 是一个本地监听器。它的更新来自一个由你持有的 Agent 目录观察：

```ts
const unsubscribe = agent.subscribe(() => {
  if (agent.status === "error") console.error(agent.lastError);
});
const directory = await client.agents.list({ subscribe: {} });

// When this view closes:
unsubscribe();
await directory.subscription.release();
```

## 列出会话加载的命令 {#list-the-commands-a-session-loaded}

```ts
const { commands, error } = await agent.commands();
if (error) throw new Error(error);

const skills = commands.filter((command) => command.kind === "skill");
```

结果来自正在运行的会话，而不是目录扫描，因此它包含 Provider 内置的、从不出现在磁盘上的命令和技能。`kind` 是 Provider 自己的分类，且是可选的；缺少 `kind` 时应视为未分类，而不是假定为 `"command"`。

无法生成列表的 Provider 会在 `error` 中报告，并返回空的 `commands` 数组。该调用不会 reject。

## 归档或解除父子关系 {#archive-or-detach}

```ts
await agent.archive(); // Soft-deletes the agent and closes its runtime.
await child.detach(); // Keeps the child alive but removes its parent relationship.
```

关闭 SDK 连接不会归档 Agent。请显式归档临时 Agent，最好放在 `finally` 中。
