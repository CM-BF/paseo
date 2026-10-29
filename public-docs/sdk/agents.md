---
title: Agents with the SDK
description: Create, run, find, reuse, parent, and archive coding agents from TypeScript.
nav: Agents
order: 52
category: TypeScript SDK
---

# Agents with the SDK

An agent handle keeps a stable agent ID and exposes the turn lifecycle without exposing daemon RPCs.

## Run an initial prompt

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

`waitForFinish()` returns one of four statuses:

| Status       | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `idle`       | The turn completed and the agent can accept another prompt.       |
| `permission` | The agent needs a person to answer a permission request in Paseo. |
| `error`      | The provider ended the turn with an error.                        |
| `timeout`    | The wait deadline elapsed; the agent may still be running.        |

A timeout does not cancel the agent.

## Recover a creation without resending

Persist the creation key, agent ID, client message ID, and complete input before dispatch. For a
new execution that must own its first prompt, pass `requireInitialPromptReservation: true`:

```ts
await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  agentId: savedAgentId,
  idempotencyKey: savedCreationKey,
  clientMessageId: savedMessageId,
  prompt: savedPrompt,
  requireInitialPromptReservation: true,
});

// After reconnect or process restart, this only reads the existing creation journal.
const receipt = await client.creations.get({ kind: "agent", idempotencyKey: savedCreationKey });
if (receipt?.initialPrompt?.status === "accepted") {
  console.log(receipt.agentId, receipt.initialPrompt.turnId);
}
```

The requirement needs `creationInitialPrompt` host support and rejects before creation on older
hosts. The host reserves Paseo-managed sends, out-of-band commands, reloads and lifecycle changes
until the new session's first native turn is admitted. It does not lock arbitrary external
clients of the provider. Native tools and permission responses work after admission; goals and
collaboration remain enabled. Creating without a prompt and sending later does not use this reservation.

`phase: "completed"` confirms creation, independently of `initialPrompt`:

| Initial prompt status | Meaning                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pending`             | Creation is still preparing or awaiting the first start result.                                                            |
| `accepted`            | The provider admitted the prompt; `turnId` is its Paseo foreground identity, not completion or a raw provider protocol ID. |
| `not_sent`            | Preparation failed before attempting native admission.                                                                     |
| `unknown`             | Admission may have happened; do not send again or create a replacement automatically.                                      |
| `out_of_band`         | A command was handed to the out-of-band handler; no foreground turn is claimed.                                            |

A missing receipt or an older receipt without `initialPrompt` does not prove that nothing ran.
A failed SessionStart hook after admission is a failure of that accepted turn. Read its native
history and permissions; the creation receipt retains its identity. Replaying an existing
creation key never resends a committed or uncertain prompt. `creations.get()` never creates or
sends, including when no journal entry exists. A lookup retains the historical receipt after
resource deletion and reports `resources.status: "unavailable"` with the validation error.
The stored agent snapshot is historical; refresh the agent to inspect its current state.

Using this pattern for each queued input creates a different native conversation each time.
Pass the required shared context explicitly and retain each execution's agent/turn identity;
do not present the executions as one continuous native session. This does not provide exact
cancellation of autonomous provider successors; see the provider boundary below.

## Recover a turn after disconnect

Use `agents.supportsInitialPromptReservation()` to check the connected host before creating
reserved first-prompt work. Still pass `requireInitialPromptReservation: true`: the SDK checks
again before sending and during creation recovery. An older host rejects with
`PaseoUnsupportedCapabilityError`, `code: "unsupported_capability"` and
`capability: "creationInitialPrompt"`, without receiving the create request. Capability queries
return false before handshake, after disconnect/disposal, or on a host without that feature.

When `agents.supportsTurnReceipts()` is true, query the exact accepted turn:

```ts
const creation = await client.creations.get({ kind: "agent", idempotencyKey });
if (creation?.agentId && creation.initialPrompt?.status === "accepted") {
  const result = await client.agents.ref(creation.agentId).turns.get({
    turnId: creation.initialPrompt.turnId,
  });
  console.log(result.status, result.clientMessageId);
}
```

Currently Codex verifies foreground terminal notifications against the native `turn/start` ACK.
Other providers and autonomous turns return `unknown` until their adapters supply equivalent
verification. The host feature advertises this query API, not complete provider coverage.

The receipt uses the same Paseo provider-adapter `turnId` returned by initial-prompt admission,
not a provider's raw protocol ID. Its key also includes the agent ID. It returns `completed`,
`failed`, `cancelled`, or `unknown`, with the original `clientMessageId` when observed. A terminal
receipt includes `observedAt` and survives disconnects, daemon restarts, runtime closure and
agent deletion. Later human turns cannot replace it. It proves a turn ended, not that the task
succeeded or that its final text is correct.

`unknown` means no durable, exact terminal observation is available. It includes a running
turn, a crash before persistence, old history, and provider events without a turn ID. It never
means not-sent and must not trigger automatic resend. Queries read the receipt store only;
they do not resume a provider, unarchive an agent, poll its current status, or infer completion
from its final text. Unsupported hosts reject before the query is sent, with capability
`agentTurnReceipts`.

The daemon awaits terminal persistence before publishing live events. If that write fails,
it logs the failure and continues existing live event/waiter delivery; recovery remains unknown.
Unreadable or corrupt receipt files fail the query rather than reporting a verified outcome.
Live events and `waitForFinish()` are not durable receipts. Synthetic shutdown/rescue cancellation
notifications and imported history do not establish a terminal receipt. Internal ephemeral
agents do not write these durable records.

## Keep a session alive for follow-ups

Create an idle session when prompts arrive later:

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

Use `send()` for fire-and-forget delivery. Use `run()` when the caller needs the outcome of that turn.

Use `steer()` when a follow-up belongs only to the turn you observed:

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

This requires host support for `agentTurnSteer`. The daemon checks the Paseo turn ID again at
delivery. `changed` means that turn is no longer active; `unavailable` means the Provider cannot
accept steering. Neither starts or interrupts a turn, and pending permissions remain open.
`accepted` acknowledges delivery, not completion. Reuse the same `messageId`, text, and
`expectedTurnId` after a lost response to retrieve the saved result. An
`agent_request_outcome_unknown` error means acceptance could not be confirmed; do not automatically
resend with a new message ID. Omit `messageId` only when the caller does not need retry recovery.

## Send only when idle

Use `sendIfIdle()` for a queue that must not interrupt or join another caller's turn:

```ts
const result = await reviewer.sendIfIdle("Run the next queued check.", {
  messageId: "queue-check-42",
});
if (result.status === "accepted") console.log(result.turnId);
```

The daemon reserves a foreground slot, then requires the provider to atomically start only
while its native session is idle. `busy` means no input was sent; active or starting turns,
replacement and pending permissions are ineligible. `unavailable` also means no input was
sent: the provider cannot guarantee native idle admission. It never steers, interrupts,
clears permissions, or unarchives the agent. Archived agents are rejected during preparation.
The `agentSendIfIdle` host capability does not imply provider support. Current production
providers, including Codex, do not implement this native guarantee; Codex's ordinary start
can append to an autonomous native turn and is never used as a fallback.

Acceptance confirms the native turn started, not that it finished. For a lost response,
retry the same text and message ID: `accepted`, `busy`, and `unavailable` are durable results.
After a confirmed unsent result, a later dispatch attempt needs a new message ID. An uncertain
receipt must not be automatically resent under a new ID.

## Find agents by label

Set `labels` at creation, then filter on them. The daemon does the matching:

```ts
const page = await client.agents.list({
  filter: { labels: { "issue-provider": "my-tracker" } },
});

for (const { agent } of page.entries) {
  console.log(agent.id, agent.title, agent.status);
}
```

## Continue an agent by ID

```ts
const agent = client.agents.ref("agent_01H8X...");

const result = await agent.run("Now write the fix.");
console.log(result.lastMessage);
```

`ref()` does not contact the daemon. Call `refresh()` first when you need to know whether the agent still exists; it returns `null` if it does not.

## Update session instructions

Update long-lived role instructions while the conversation is idle, without replacing the Agent or resending its history:

```ts
const snapshot = await agent.updateInstructions({
  systemPrompt: "You review checkout changes. Explain risks before suggesting edits.",
  // Omit mcpServers to preserve the current tool configuration.
});
console.log(snapshot.id);
```

Native skill projections can be added when creating an agent with
`config.skillMounts: [{ directory: "/absolute/plugin-data/projection" }]`, or supplied to the
same idle `updateInstructions` operation. They require host feature `nativeSkillMounts`; older
hosts are rejected before a request is sent. Omit the field to preserve existing mounts, or use
`[]` in an update to clear them. The full `systemPrompt` is still required by an instruction update.

For plugins that may bundle an older SDK, check the public method on the **same API instance**
used for creation or update. An older bundled schema may silently drop fields it does not know:

```ts
if (
  typeof client.agents.supportsNativeSkillMounts !== "function" ||
  !client.agents.supportsNativeSkillMounts()
) {
  throw new Error("Update the SDK and connect to a host with native skill mount support.");
}
```

The method reads that connection's advertised capability and returns false while disconnected.
A plugin's host-provided `context.paseo` and its own bundled Node client are separate API instances;
support on one does not certify the other. This reports host support, not a native provider's catalog.

A projection contains `skills/<name>/SKILL.md` and a `.claude-plugin/plugin.json` with only
`name`, optional `version`, and optional `description`. Hooks, agents, commands, MCP/LSP config,
noncanonical skill filenames, and manifest/skill-root symlinks escaping the projection are rejected. Keep projections
in durable plugin data, not a checkout that an upgrade can remove. Skills retain their original
resources and permissions; a mount does not preapprove tools or replace user/project skills.

Codex mounts are added to the agent's own app-server process and checked against its native
catalog before starting or resuming a thread. Native child threads in that process share them;
other Paseo agents do not. Claude uses session-local plugins with MCP discovery disabled.
Missing projections, undiscovered Codex skills and unsupported providers fail instead of silently
running without skills. Runtime roots are reapplied on resume. Directory references are not content
snapshots: explicitly mounting the same mutable directory in two agents shares those files.
No global provider home is changed. Actual skill loading still depends on the native model/tool
flow; catalog visibility alone is not proof that a skill was read or executed.

Mark application settings as applied only after the call succeeds. The daemon keeps the same durable conversation and timeline, and refuses active turns, pending permissions, and active children without interrupting them. This operation restarts the Provider runtime and cannot preserve background work the Provider does not report. See the [API reference](./reference.md#agent-handle) for error codes and recovery.

## Create a subagent

Create a child through its workspace. The handle owns placement, so the caller does not repeat its directory:

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

`parent` establishes parentage. Archiving a parent cascade-archives its children. Call `detach()` first when a child should continue independently.

## Run work in a background workspace

Create a background workspace and its first agent in one call. Put `background` on the
workspace options and the agent's configuration under `agent`:

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

The call returns a workspace handle and starts its first agent with the supplied prompt.

Background agents keep their history and survive daemon restarts. Default discovery hides them;
use `client.agents.list({ filter: { includeBackground: true } })` to include them.
Exact-ID handles work normally. See [workspace creation](./workspaces.md#create-a-fresh-workspace)
for defaults and caller inheritance.

## Request structured output

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

Validate the parsed value in your application before using it as trusted input.

## Read the current state of an agent

```ts
const agent = client.agents.ref("agent_01H8X...");
await agent.refresh();

if (agent.pendingPermissions?.length) {
  console.log(`Waiting on ${agent.pendingPermissions.length} permission request(s)`);
}
console.log(agent.lastUsage?.totalCostUsd, agent.runtimeInfo?.sessionId);
```

The handle exposes `status`, `capabilities`, `availableModes`, `pendingPermissions`, `activeTurn`, `lastUsage`, `lastError`, `features`, `runtimeInfo`, `archivedAt`, `workspaceId`, and `cwd` as properties. All of them read the last snapshot the handle observed and never fetch.

A handle from `ref()` has observed nothing, so every one of them is `null` until `refresh()`, `run()`, `waitForFinish()`, a timeline refetch, or `subscribe()` delivers a snapshot. Optional values in an observed snapshot also read as `null`. Use `current()` when you need the whole snapshot or need to distinguish those states.

`subscribe()` is a local listener. An owned agent-directory observation supplies its updates:

```ts
const unsubscribe = agent.subscribe(() => {
  if (agent.status === "error") console.error(agent.lastError);
});
const directory = await client.agents.list({ subscribe: {} });

// When this view closes:
unsubscribe();
await directory.subscription.release();
```

## List the commands a session loaded

```ts
const { commands, error } = await agent.commands();
if (error) throw new Error(error);

const skills = commands.filter((command) => command.kind === "skill");
```

The answer comes from the running session, not from a directory scan, so it includes commands and skills built into the provider that never appear on disk. `kind` is the provider's own classification and is optional; treat a missing `kind` as unclassified rather than assuming `"command"`.

A provider that cannot produce a list reports that in `error` and returns an empty `commands` array. The call does not reject.

## Archive or detach

```ts
await agent.archive(); // Soft-deletes the agent and closes its runtime.
await child.detach(); // Keeps the child alive but removes its parent relationship.
```

Closing the SDK connection does not archive agents. Archive temporary agents explicitly, preferably in `finally`.
