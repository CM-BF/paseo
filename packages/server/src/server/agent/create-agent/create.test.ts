import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { createAgentCommand } from "./create.js";
import type { ManagedAgent } from "../agent-manager.js";

const logger = createTestLogger();

function createRealAgentManager(storage: AgentStorage): AgentManager {
  return new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
}

async function removeRealAgentManagerWorkdir({
  agentManager,
  storage,
  workdir,
}: {
  agentManager: AgentManager;
  storage: AgentStorage;
  workdir: string;
}): Promise<void> {
  agentManager.prepareForShutdown();
  await Promise.all(agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)));
  await agentManager.flushForShutdown();
  await storage.flush();
  rmSync(workdir, { recursive: true, force: true });
}

// Creates a worktree directory under repoRoot and reports it back as a fresh
// workspace so the command can stamp the agent with it (mirrors the production
// worktree service).
function fakeWorktreeCreator(args: { repoRoot: string; createdWorkspaceId: string }) {
  const worktreePath = join(args.repoRoot, "worktree");
  const workspaceCwd = join(worktreePath, "packages", "app");
  mkdirSync(workspaceCwd, { recursive: true });
  return async (): Promise<CreatePaseoWorktreeWorkflowResult> =>
    ({
      worktree: { worktreePath },
      intent: {},
      workspace: { workspaceId: args.createdWorkspaceId, cwd: workspaceCwd },
      repoRoot: args.repoRoot,
      created: true,
    }) as unknown as CreatePaseoWorktreeWorkflowResult;
}

test("session create forwards clientMessageId to the initial prompt run options", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const startCreatedAgentRun = vi.fn(async () => ({
    disposition: "turn_started",
    turnId: "native-first",
  }));
  const owner = Symbol("test creation");
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      withInitialPromptReservation: (
        _id: unknown,
        run: (id: string, owner: symbol) => Promise<unknown>,
      ) => run("agent-1", owner),
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      reloadStalePluginSession: async () => {},
      startCreatedAgentRun,
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    workspaceId: "ws-create-test",
    initialPrompt: "hello from create",
    clientMessageId: "msg-create-1",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
  });

  expect(startCreatedAgentRun).toHaveBeenCalledWith(
    "agent-1",
    "hello from create",
    {
      clientMessageId: "msg-create-1",
    },
    owner,
    expect.any(Function),
  );
});

test("session create validates the requested mode against the provider's modes", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockRejectedValue(
    new Error("Invalid mode 'plan' for provider 'opencode'. Available modes: build, myplan"),
  );
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "plan" },
      workspaceId: "ws-create-test",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
    }),
  ).rejects.toThrow("Invalid mode 'plan'");

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "opencode",
      cwd: "/tmp/paseo-create-test",
      requestedMode: "plan",
    }),
  );
  expect(createAgent).not.toHaveBeenCalled();
});

test("session create applies the resolved mode from the provider create config", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockResolvedValue({
    modeId: "build",
    featureValues: { auto_accept: true },
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "build" },
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      modeId: "build",
      featureValues: { auto_accept: true },
    }),
    undefined,
    expect.anything(),
  );
});

test("mcp create accepts provider-only internal input and leaves model undefined", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const owner = Symbol("test MCP creation");
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      withInitialPromptReservation: (
        _id: unknown,
        run: (id: string, owner: symbol) => Promise<unknown>,
      ) => run("agent-1", owner),
      startCreatedAgentRun: async () => ({ disposition: "turn_started", turnId: "mcp-first" }),
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async (input) => {
        expect(input.provider).toBe("claude");
        return {};
      }),
    } as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    workspaceId: "ws-create-test",
    title: "provider default",
    initialPrompt: "hello",
    notifyOnFinish: false,
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude",
      model: undefined,
    }),
    "agent-1",
    expect.objectContaining({
      workspaceId: "ws-create-test",
    }),
    owner,
  );
});

test("session create stamps the requested workspaceId when no worktree setup runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-source");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create stamps the new worktree's workspaceId, not the parent's", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
      },
    );

    const { snapshot: child } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager,
        createPaseoWorktree: fakeWorktreeCreator({
          repoRoot: workdir,
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "child",
        initialPrompt: "do the thing",
        notifyOnFinish: false,
        callerAgentId: parent.id,
        worktree: { worktreeName: "feature", baseBranch: "main" },
      },
    );

    const storedChild = await storage.get(child.id);
    expect(storedChild?.workspaceId).toBe("ws-new-worktree");
    expect(child.cwd).toBe(join(workdir, "worktree", "packages", "app"));
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create exposes the created worktree before dispatching the initial prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-worktree-callback-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const createdWorktree = await fakeWorktreeCreator({
    repoRoot: workdir,
    createdWorkspaceId: "ws-created-worktree",
  })();
  let observed:
    | {
        createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
        lifecycle: ManagedAgent["lifecycle"] | null;
      }
    | undefined;

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return {};
          },
        },
        createPaseoWorktree: async () => createdWorktree,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        title: "worktree callback",
        initialPrompt: "Say done.",
        notifyOnFinish: false,
        worktree: { worktreeName: "feature", baseBranch: "main" },
        onCreated: ({ agentId, createdWorktree: callbackWorktree }) => {
          observed = {
            createdWorktree: callbackWorktree,
            lifecycle: agentManager.getAgent(agentId)?.lifecycle ?? null,
          };
        },
      },
    );

    expect(observed).toEqual({ createdWorktree, lifecycle: "idle" });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps the prompt title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Implement auth retries with backoff";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-title-source",
        initialPrompt: `${title}\n\ninclude tests`,
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps an explicit title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-explicit-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Explicit override";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir, title },
        workspaceId: "ws-explicit-title-source",
        initialPrompt: "Implement auth retries with backoff",
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create with an internal config skips provider session persistence", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };
  const input = {
    kind: "session" as const,
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
  };

  await createAgentCommand(dependencies, {
    ...input,
    config: { provider: "codex", cwd: "/tmp/paseo-create-test", internal: true },
  });
  await createAgentCommand(dependencies, {
    ...input,
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
  });

  expect(createAgent).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ provider: "codex", internal: true }),
    undefined,
    expect.objectContaining({ persistSession: false }),
  );
  expect(createAgent.mock.calls[1]?.[0]).not.toHaveProperty("internal");
  expect(createAgent.mock.calls[1]?.[2]).not.toHaveProperty("persistSession");
});

function creationGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("published new agents reserve their first prompt against send, commands and lifecycle mutations", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "creation-first-prompt-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const starts: unknown[] = [];
  const agentManager = new AgentManager({
    clients: createTestAgentClients({
      onStartTurn: (prompt) => {
        starts.push(prompt);
      },
    }),
    registry: storage,
    logger,
  });
  const ready = creationGate();
  const release = creationGate();
  let id = "";
  const creation = createAgentCommand(
    {
      agentManager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    },
    {
      kind: "session",
      config: { provider: "codex", cwd: workdir },
      workspaceId: "ws-first",
      initialPrompt: "The creation owns this input",
      clientMessageId: "first-input",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: {},
      onAgentReady: async (agent) => {
        id = agent.id;
        ready.resolve();
        await release.promise;
      },
    },
  );
  try {
    await ready.promise;
    expect(agentManager.getAgent(id)?.lifecycle).toBe("idle");
    expect(() => agentManager.streamAgent(id, "competing human input")).toThrow("creation-owned");
    await expect(agentManager.tryRunOutOfBand(id, "/goal competing goal")).rejects.toThrow(
      "creation-owned",
    );
    await expect(agentManager.cancelAgentRun(id)).rejects.toThrow("creation-owned");
    await expect(agentManager.archiveAgent(id)).rejects.toThrow("creation-owned");
    await expect(agentManager.rewind(id, "foreign-message", "conversation")).rejects.toThrow(
      "creation-owned",
    );
    await expect(agentManager.reloadAgentSession(id)).rejects.toThrow("creation-owned");
    await expect(agentManager.setAgentModel(id, "competing-model")).rejects.toThrow(
      "creation-owned",
    );
    expect(starts).toEqual([]);
    release.resolve();
    const result = await creation;
    expect(result.initialPrompt).toEqual({
      status: "accepted",
      clientMessageId: "first-input",
      turnId: "fake-turn-0",
    });
    expect(starts).toEqual(["The creation owns this input"]);
    await agentManager.waitForAgentEvent(id, { waitForActive: true });
    await expect(
      agentManager.runAgent(id, "Later explicit native conversation"),
    ).resolves.toBeDefined();
  } finally {
    release.resolve();
    await creation.catch(() => undefined);
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("a failed first-turn start is unknown and never retried or reopened", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "creation-start-unknown-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const clients = createTestAgentClients();
  const original = clients.codex.createSession.bind(clients.codex);
  const start = vi.fn(async () => {
    throw new Error("Native start ACK lost");
  });
  const create = vi.spyOn(clients.codex, "createSession").mockImplementation(async (...args) => {
    const session = await original(...args);
    session.startTurn = start;
    return session;
  });
  const agentManager = new AgentManager({ clients, registry: storage, logger });
  try {
    const result = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-unknown",
        initialPrompt: "One attempt",
        clientMessageId: "uncertain-first",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: {},
      },
    );
    expect(result.initialPromptStarted).toBe(false);
    expect(result.initialPrompt).toEqual({
      status: "unknown",
      clientMessageId: "uncertain-first",
      error: "Native start ACK lost",
    });
    expect(agentManager.getAgent(result.snapshot.id)).not.toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("a native failure after initial admission does not erase the accepted first-turn identity", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "creation-start-failure-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  try {
    const result = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-failed-turn",
        initialPrompt: "emit a turn failure",
        clientMessageId: "failed-turn",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: {},
      },
    );
    expect(result.initialPrompt).toEqual({
      status: "accepted",
      clientMessageId: "failed-turn",
      turnId: "fake-turn-0",
    });
    await agentManager.waitForAgentEvent(result.snapshot.id, { waitForActive: true });
    expect(agentManager.getAgent(result.snapshot.id)?.lastError).toContain(
      "Requested fake provider failure",
    );
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("lost native start ACK preserves the actual first turn and its permission instead of fabricating failure", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "creation-start-permission-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const clients = createTestAgentClients();
  const original = clients.codex.createSession.bind(clients.codex);
  const permission = creationGate();
  let starts = 0;
  vi.spyOn(clients.codex, "createSession").mockImplementation(async (...args) => {
    const session = await original(...args);
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (listener) =>
      subscribe((event) => {
        listener(event);
        if (event.type === "permission_requested") permission.resolve();
      });
    const start = session.startTurn.bind(session);
    session.startTurn = async (prompt, options) => {
      starts++;
      await start(prompt, options);
      await permission.promise;
      throw new Error("ACK lost after permission requested");
    };
    return session;
  });
  const agentManager = new AgentManager({ clients, registry: storage, logger });
  let fabricatedFailures = 0;
  const unsubscribe = agentManager.subscribe((event) => {
    if (event.type === "agent_stream" && event.event.type === "turn_failed") fabricatedFailures++;
  });
  try {
    const result = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-start-permission",
        initialPrompt: "printf ok > permission.txt",
        clientMessageId: "permission-first",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: {},
      },
    );
    expect(result.initialPrompt?.status).toBe("unknown");
    expect(agentManager.getPendingPermissions(result.snapshot.id)).toHaveLength(1);
    expect(agentManager.getAgent(result.snapshot.id)?.activeTurnId).toBe("fake-turn-0");
    expect(agentManager.getAgent(result.snapshot.id)?.lifecycle).not.toBe("error");
    expect(starts).toBe(1);
    expect(fabricatedFailures).toBe(0);
  } finally {
    unsubscribe();
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test.each(["before-dispatch", "after-attempt"])(
  "shutdown releases a creation reservation %s without late dispatch",
  async (stage) => {
    const workdir = mkdtempSync(join(tmpdir(), "creation-shutdown-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const clients = createTestAgentClients();
    const original = clients.codex.createSession.bind(clients.codex);
    const reached = creationGate();
    const release = creationGate();
    let id = "";
    const start = vi.fn(async () => {
      reached.resolve();
      await release.promise;
      throw new Error("Native start closed during shutdown");
    });
    vi.spyOn(clients.codex, "createSession").mockImplementation(async (...args) => {
      const session = await original(...args);
      const close = session.close.bind(session);
      session.close = async () => {
        release.resolve();
        await close();
      };
      session.startTurn = start;
      return session;
    });
    const manager = new AgentManager({ clients, registry: storage, logger });
    const creation = createAgentCommand(
      {
        agentManager: manager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-shutdown",
        initialPrompt: "First",
        clientMessageId: "shutdown-first",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: {},
        onAgentReady: async (agent) => {
          id = agent.id;
          if (stage === "before-dispatch") {
            reached.resolve();
            await release.promise;
          }
        },
      },
    );
    try {
      await reached.promise;
      manager.prepareForShutdown();
      // Same order as bootstrap: close, drain registration/persistence, provider shutdown.
      await manager.closeAgent(id);
      await manager.flushForShutdown();
      const result = await creation;
      expect(result.initialPrompt?.status).toBe(
        stage === "before-dispatch" ? "not_sent" : "unknown",
      );
      expect(start).toHaveBeenCalledTimes(stage === "before-dispatch" ? 0 : 1);
    } finally {
      release.resolve();
      await creation.catch(() => undefined);
      await removeRealAgentManagerWorkdir({ agentManager: manager, storage, workdir });
    }
  },
);

test("shutdown across out-of-band preparation does not attempt a native first prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "creation-shutdown-prepare-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const clients = createTestAgentClients();
  const manager = new AgentManager({ clients, registry: storage, logger });
  const original = clients.codex.createSession.bind(clients.codex);
  const start = vi.fn();
  vi.spyOn(clients.codex, "createSession").mockImplementation(async (...args) => {
    const session = await original(...args);
    session.tryHandleOutOfBand = () => {
      manager.prepareForShutdown();
      return null;
    };
    session.startTurn = start;
    return session;
  });
  try {
    const result = await createAgentCommand(
      {
        agentManager: manager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-shutdown-prepare",
        initialPrompt: "First",
        clientMessageId: "shutdown-prepared",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: {},
      },
    );
    expect(result.initialPrompt?.status).toBe("not_sent");
    expect(start).not.toHaveBeenCalled();
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager: manager, storage, workdir });
  }
});

test("parent archive rejects before mutating either record while a child owns its first input", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "creation-parent-archive-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = createRealAgentManager(storage);
  const ready = creationGate();
  const release = creationGate();
  const parent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: "ws-parent",
    labels: {},
  });
  let childId = "";
  const creation = createAgentCommand(
    {
      agentManager: manager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    },
    {
      kind: "session",
      config: { provider: "codex", cwd: workdir },
      workspaceId: "ws-parent",
      initialPrompt: "Child first",
      labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
      provisionalTitle: null,
      firstAgentContext: {},
      onAgentReady: async (agent) => {
        childId = agent.id;
        ready.resolve();
        await release.promise;
      },
    },
  );
  try {
    await ready.promise;
    await expect(manager.archiveAgent(parent.id)).rejects.toThrow("creation-owned");
    expect(await storage.get(parent.id)).not.toBeNull();
    expect((await storage.get(parent.id))?.archivedAt).toBeFalsy();
    expect(await storage.get(childId)).not.toBeNull();
    expect((await storage.get(childId))?.archivedAt).toBeFalsy();
    release.resolve();
    expect((await creation).initialPrompt?.status).toBe("accepted");
  } finally {
    release.resolve();
    await creation.catch(() => undefined);
    await removeRealAgentManagerWorkdir({ agentManager: manager, storage, workdir });
  }
});

test("a destructive scope blocks a new creation until teardown completes", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "creation-destructive-admission-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = createRealAgentManager(storage);
  const entered = creationGate();
  const release = creationGate();
  const mutation = manager.withInitialPromptMutation(
    { workspaceIds: ["ws-teardown"] },
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  try {
    await entered.promise;
    await expect(
      createAgentCommand(
        {
          agentManager: manager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        },
        {
          kind: "session",
          config: { provider: "codex", cwd: workdir },
          workspaceId: "ws-teardown",
          initialPrompt: "Must not race deletion",
          labels: {},
          provisionalTitle: null,
          firstAgentContext: {},
        },
      ),
    ).rejects.toThrow("creation-owned");
    expect(manager.listAgents()).toEqual([]);
  } finally {
    release.resolve();
    await mutation;
    await removeRealAgentManagerWorkdir({ agentManager: manager, storage, workdir });
  }
});

test("a complete native event replay before the start ACK retains the admitted foreground identity", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "creation-start-replay-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const clients = createTestAgentClients();
  const original = clients.codex.createSession.bind(clients.codex);
  const completed = creationGate();
  vi.spyOn(clients.codex, "createSession").mockImplementation(async (...args) => {
    const session = await original(...args);
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (listener) =>
      subscribe((event) => {
        listener(event);
        if (event.type === "turn_completed") completed.resolve();
      });
    const start = session.startTurn.bind(session);
    session.startTurn = async (...input) => {
      const accepted = await start(...input);
      await completed.promise;
      return accepted;
    };
    return session;
  });
  const manager = new AgentManager({ clients, registry: storage, logger });
  try {
    const result = await createAgentCommand(
      {
        agentManager: manager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-full-replay",
        initialPrompt: "Hello",
        clientMessageId: "replayed-first",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: {},
      },
    );
    expect(result.initialPrompt).toEqual({
      status: "accepted",
      clientMessageId: "replayed-first",
      turnId: "fake-turn-0",
    });
    await manager.waitForAgentEvent(result.snapshot.id, { waitForActive: true });
    expect(manager.getAgent(result.snapshot.id)?.activeTurnId).toBeNull();
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager: manager, storage, workdir });
  }
});
