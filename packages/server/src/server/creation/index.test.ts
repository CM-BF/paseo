import pino from "pino";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { CreationService, type CreationInput } from "./index.js";

const silentLogger = pino({ level: "silent" });
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const workspace: WorkspaceDescriptorPayload = {
  id: "wks_0123456789abcdef",
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/project",
  workspaceDirectory: "/project/worktree",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "Worktree",
  status: "running",
  statusEnteredAt: null,
  activityAt: null,
  archivingAt: null,
  scripts: [],
};
const agent: AgentSnapshotPayload = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: workspace.id,
  provider: "codex",
  cwd: "/project/worktree",
  model: null,
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: true,
    supportsRewindConversation: false,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Start once",
  labels: {},
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "creation-lifecycle-"));
  directories.push(directory);
  const service = new CreationService(directory, silentLogger);
  const provider = deferred();
  const ready = deferred();
  const calls: string[] = [];
  const input: CreationInput = {
    kind: "workspace",
    key: "submit-one",
    request: { source: "/project", prompt: "Start once" },
    workspaceId: workspace.id,
    agentId: agent.id,
    hasAgent: true,
    hasPrompt: true,
    exists: async () => false,
    provision: async () => {
      calls.push("workspace");
      return { workspace };
    },
    createAgent: async (_id, _workspace, onReady) => {
      await provider.promise;
      calls.push("agent");
      await onReady(agent);
      calls.push("prompt");
      return { agent, initialPromptStarted: true };
    },
  };
  const updates: CreationSnapshot[] = [];
  const observe = (snapshot: CreationSnapshot) => {
    updates.push(snapshot);
    if (snapshot.phase === "workspace_ready") ready.resolve();
  };
  return { directory, service, input, provider, ready, calls, updates, observe };
}

test("workspace readiness is observable before provider startup and duplicate requests join the same work", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  expect(f.calls).toEqual(["workspace"]);
  expect(f.updates.map((s) => s.phase)).toEqual(["accepted", "workspace_ready"]);
  expect(f.updates[0]).toMatchObject({ workspaceId: workspace.id, agentId: agent.id });
  const duplicate = f.service.create(f.input);
  f.provider.resolve();
  expect(await first).toMatchObject({ phase: "completed", error: null, workspace, agent });
  expect(await duplicate).toEqual(await first);
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(await first);
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
});

test("a failed agent startup retries only that stage with the reserved IDs", async () => {
  const f = await fixture();
  let attempts = 0;
  f.input.createAgent = async (id, readyWorkspace, onReady) => {
    attempts++;
    expect(id).toBe(agent.id);
    expect(readyWorkspace).toEqual(workspace);
    if (attempts === 1) throw new Error("provider unavailable");
    await onReady(agent);
    return { agent, initialPromptStarted: true };
  };
  expect(await f.service.create(f.input)).toMatchObject({
    phase: "failed",
    failedStage: "agent",
    outcomeUnknown: false,
    workspace,
  });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toMatchObject({
    phase: "completed",
    agent,
  });
  expect(f.calls).toEqual(["workspace"]);
  expect(attempts).toBe(2);
});

test("an uncertain prompt outcome never resends or removes its workspace and agent", async () => {
  const f = await fixture();
  let prompts = 0;
  f.input.createAgent = async (_id, _workspace, onReady) => {
    await onReady(agent);
    prompts++;
    throw new Error("connection lost after provider accepted prompt");
  };
  const result = await f.service.create(f.input);
  expect(result).toMatchObject({
    phase: "failed",
    failedStage: "prompt",
    outcomeUnknown: true,
    workspace,
    agent,
  });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
  expect(prompts).toBe(1);
});

test("conflicting intents and resource IDs cannot start more work", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  await expect(f.service.create({ ...f.input, request: { prompt: "changed" } })).rejects.toThrow(
    "workspace_request_key_conflict",
  );
  await expect(f.service.create({ ...f.input, key: "another-intent" })).rejects.toThrow(
    "workspace_id_conflict",
  );
  f.provider.resolve();
  expect(await first).toMatchObject({ phase: "completed", error: null });
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
});

test("late subscribers recover readiness and removing an observer cannot stop creation", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  const updates: CreationSnapshot[] = [];
  const subscription = await f.service.subscribe("workspace", f.input.key, (snapshot) =>
    updates.push(snapshot),
  );
  expect(subscription.snapshot).toMatchObject({ phase: "workspace_ready", workspace });
  subscription.unsubscribe();
  f.provider.resolve();
  await first;
  expect(updates).toEqual([]);
  const completed = await new CreationService(f.directory, silentLogger).subscribe(
    "workspace",
    f.input.key,
    () => {},
  );
  expect(completed.snapshot).toMatchObject({ phase: "completed", agent, workspace });
  completed.unsubscribe();
});

test("omitted resource IDs are generated once and preserved on replay", async () => {
  const f = await fixture();
  f.input.workspaceId = undefined;
  f.input.agentId = undefined;
  f.input.provision = async (id) => ({ workspace: { ...workspace, id } });
  f.input.createAgent = async (id, createdWorkspace, onReady) => {
    const created = { ...agent, id, workspaceId: createdWorkspace!.id };
    await onReady(created);
    return { agent: created, initialPromptStarted: true };
  };
  const result = await f.service.create(f.input);
  expect(result.workspaceId).toMatch(/^wks_[a-f0-9]{16}$/);
  expect(result.agentId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
});

test("restart after a committed agent without a prompt completes without recreating the agent", async () => {
  const f = await fixture();
  const recoveredDirectory = await mkdtemp(join(tmpdir(), "creation-checkpoint-"));
  directories.push(recoveredDirectory);
  f.input.hasPrompt = false;
  let starts = 0;
  f.input.createAgent = async (_id, _workspace, onReady) => {
    starts++;
    await onReady(agent);
    // Capture the durable state at the exact milestone a process could stop after.
    await cp(f.directory, recoveredDirectory, { recursive: true });
    return { agent, initialPromptStarted: false };
  };
  await f.service.create(f.input);
  const recovered = await new CreationService(recoveredDirectory, silentLogger).create(f.input);
  expect(recovered).toMatchObject({ phase: "completed", workspace, agent });
  expect(starts).toBe(1);
});

test("partial provisioning without a registered workspace is not repeated", async () => {
  const f = await fixture();
  let provisions = 0;
  f.input.provision = async () => {
    provisions++;
    await writeFile(join(f.directory, "partial-checkout"), "disk was changed");
    throw new Error("Git failed after creating the checkout");
  };
  const result = await f.service.create(f.input);
  expect(result).toMatchObject({ phase: "failed", failedStage: "workspace", outcomeUnknown: true });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
  expect(provisions).toBe(1);
});

test.each([
  ["pending", false],
  ["completed", false],
  ["completed", true],
] as const)(
  "imports a %s legacy agent receipt (prompt %s) without inventing a first-message receipt",
  async (state, hasPrompt) => {
    const f = await fixture();
    const legacyDirectory = join(f.directory, "legacy");
    await mkdir(legacyDirectory);
    const request = { config: { cwd: "/project", provider: "codex" } };
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await writeFile(
      join(legacyDirectory, `${hash(["create", "old-key"])}.json`),
      JSON.stringify({
        fingerprint: hash({ ...request, type: "create_agent_request" }),
        state,
        agentId: agent.id,
      }),
    );
    const input: CreationInput = {
      kind: "agent",
      key: "old-key",
      request,
      hasAgent: true,
      hasPrompt,
      exists: async () => true,
      readAgent: async () => agent,
      createAgent: async () => {
        throw new Error("Must not create again");
      },
    };
    const service = new CreationService(f.directory, silentLogger, undefined, legacyDirectory);
    await expect(
      service.create({ ...input, request: { config: { ...request.config, cwd: "/changed" } } }),
    ).rejects.toThrow("agent_request_key_conflict");
    const imported = await service.create(input);
    expect(imported).toMatchObject({ phase: "completed", agent });
    expect(imported.initialPrompt).toBeUndefined();
    expect(await new CreationService(f.directory, silentLogger).create(input)).toMatchObject({
      phase: "completed",
      agent,
    });
  },
);

test("observer failures are logged without failing creation", async () => {
  const f = await fixture();
  const logs: unknown[] = [];
  const logger = pino(
    { level: "warn" },
    {
      write: (line) => {
        logs.push(JSON.parse(line));
      },
    },
  );
  const service = new CreationService(f.directory, logger);
  f.provider.resolve();
  const result = await service.create(f.input, () => {
    throw new Error("delivery failed");
  });
  expect(result.phase).toBe("completed");
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      level: 40,
      kind: "workspace",
      idempotencyKey: f.input.key,
      phase: "workspace_ready",
      err: expect.objectContaining({ message: "delivery failed" }),
    }),
  );
});

test("accepted initial prompt identity survives lost final ACK and a read-only restart lookup", async () => {
  const f = await fixture();
  let prompts = 0;
  f.input.clientMessageId = "fixed-first-message";
  f.input.createAgent = async (_id, _workspace, onReady, clientMessageId) => {
    await onReady(agent);
    const checkpoint = await f.service.subscribe("workspace", f.input.key, () => {});
    expect(checkpoint.snapshot?.initialPrompt).toEqual({ status: "pending", clientMessageId });
    checkpoint.unsubscribe();
    prompts++;
    return {
      agent,
      initialPromptStarted: true,
      initialPrompt: {
        status: "accepted",
        clientMessageId: clientMessageId!,
        turnId: "native-first-turn",
      },
    };
  };
  const original = await f.service.create(f.input);
  const restarted = new CreationService(f.directory, silentLogger);
  const read = await restarted.subscribe("workspace", f.input.key, () => {});
  expect(read.snapshot).toMatchObject({
    phase: original.phase,
    agentId: original.agentId,
    revision: original.revision,
  });
  expect(read.snapshot?.initialPrompt).toEqual({
    status: "accepted",
    clientMessageId: "fixed-first-message",
    turnId: "native-first-turn",
  });
  read.unsubscribe();
  expect(await restarted.create(f.input)).toEqual(original);
  expect(prompts).toBe(1);
});

test("restart between prompt dispatch and ACK retains unknown rather than recreating or resending", async () => {
  const f = await fixture();
  const dispatch = deferred();
  const release = deferred();
  let prompts = 0;
  f.input.createAgent = async (_id, _workspace, onReady) => {
    await onReady(agent);
    prompts++;
    dispatch.resolve();
    await release.promise;
    throw new Error("start result lost");
  };
  const running = f.service.create(f.input);
  await dispatch.promise;
  const restartedDirectory = `${f.directory}-restart`;
  directories.push(restartedDirectory);
  await cp(f.directory, restartedDirectory, { recursive: true });
  const restarted = new CreationService(restartedDirectory, silentLogger);
  const read = await restarted.subscribe("workspace", f.input.key, () => {});
  expect(read.snapshot).toMatchObject({
    outcomeUnknown: true,
    initialPrompt: { status: "unknown", clientMessageId: expect.any(String) },
  });
  read.unsubscribe();
  const { resources: _resources, ...historical } = read.snapshot!;
  expect(await restarted.create(f.input)).toEqual(historical);
  expect(prompts).toBe(1);
  release.resolve();
  await running;
});

test("completed creation keeps an explicit unknown prompt result and a missing lookup does not create", async () => {
  const f = await fixture();
  f.input.createAgent = async (_id, _workspace, onReady, clientMessageId) => {
    await onReady(agent);
    return {
      agent,
      initialPromptStarted: false,
      initialPrompt: {
        status: "unknown",
        clientMessageId: clientMessageId!,
        error: "SessionStart result unavailable",
      },
    };
  };
  const result = await f.service.create(f.input);
  expect(result).toMatchObject({
    phase: "completed",
    error: null,
    initialPrompt: { status: "unknown", error: "SessionStart result unavailable" },
  });
  const missing = await f.service.subscribe("agent", "never-submitted", () => {});
  expect(missing.snapshot).toBeNull();
  missing.unsubscribe();
  expect(f.calls).toEqual(["workspace"]);
});

test("read-only lookup keeps the durable first-prompt receipt after its agent is deleted", async () => {
  const f = await fixture();
  f.input.createAgent = async (_id, _workspace, onReady) => {
    await onReady(agent);
    return {
      agent,
      initialPromptStarted: true,
      initialPrompt: {
        status: "accepted",
        clientMessageId: "deleted-first",
        turnId: "original-turn",
      },
    };
  };
  const completed = await f.service.create(f.input);
  const recovered = new CreationService(f.directory, silentLogger, async () => {
    throw new Error("Previously created agent no longer exists");
  });
  const lookup = await recovered.subscribe("workspace", f.input.key, () => {});
  expect(lookup.snapshot).toMatchObject({
    phase: completed.phase,
    initialPrompt: completed.initialPrompt,
    resources: { status: "unavailable", error: "Previously created agent no longer exists" },
  });
  lookup.unsubscribe();
  await expect(recovered.create(f.input)).rejects.toThrow(
    "Previously created agent no longer exists",
  );
});

test("creation receipts bind native skill mounts and never replay a different projection", async () => {
  const f = await fixture();
  const request = {
    config: { provider: "codex", cwd: "/project", skillMounts: [{ directory: "/skills/a" }] },
  };
  const input: CreationInput = { ...f.input, kind: "agent", request };
  f.provider.resolve();
  await f.service.create(input);
  await expect(
    f.service.create({
      ...input,
      request: { config: { ...request.config, skillMounts: [{ directory: "/skills/b" }] } },
    }),
  ).rejects.toThrow("agent_request_key_conflict");
});
