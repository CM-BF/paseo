import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "claude-mount-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, ".claude-plugin"));
  await mkdir(path.join(directory, "skills", "fixture"), { recursive: true });
  await writeFile(path.join(directory, ".claude-plugin", "plugin.json"), '{"name":"fixture"}');
  await writeFile(
    path.join(directory, "skills", "fixture", "SKILL.md"),
    "---\nname: fixture\ndescription: Fixture\n---\nBody",
  );
  const options: Options[] = [];
  const queryFactory = vi.fn(({ options: input }: ClaudeQueryInput) => {
    options.push(input);
    const events = [
      {
        type: "system",
        subtype: "init",
        session_id: "native-skill-fixture",
        model: "opus",
        permissionMode: "default",
        skills: ["fixture:fixture"],
        plugins: [{ name: "fixture", path: directory }],
      },
      { type: "assistant", message: { content: "Done" } },
      {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
      },
    ];
    return {
      next: vi.fn(async () =>
        events.length ? { done: false, value: events.shift() } : { done: true, value: undefined },
      ),
      return: vi.fn(async () => ({ done: true, value: undefined })),
      close: vi.fn(),
      interrupt: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as unknown as Query;
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude",
  });
  return { directory, options, client, queryFactory };
}

test("uses session-local skill-only plugins and restores mounts from native metadata", async () => {
  const f = await fixture();
  const session = await f.client.createSession({
    provider: "claude",
    cwd: f.directory,
    skillMounts: [{ directory: f.directory }],
  });
  cleanups.push(() => session.close());
  await session.run("Use the fixture");
  expect(f.options[0]?.plugins).toEqual([
    { type: "local", path: f.directory, skipMcpDiscovery: true },
  ]);
  expect(f.options[0]?.settingSources).toEqual(["user", "project", "local"]);
  expect(f.options[0]?.skills).toBeUndefined();
  const persistence = session.describePersistence()!;
  expect(persistence.metadata?.skillMounts).toEqual([{ directory: f.directory }]);
  await session.close();
  const resumed = await f.client.resumeSession(persistence);
  cleanups.push(() => resumed.close());
  await resumed.run("Again");
  expect(f.options[1]?.resume).toBe("native-skill-fixture");
  expect(f.options[1]?.plugins).toEqual(f.options[0]?.plugins);
});

test("missing or unsafe skill mounts never launch a Claude query", async () => {
  const f = await fixture();
  await writeFile(path.join(f.directory, ".mcp.json"), "{}");
  await expect(
    f.client.createSession({
      provider: "claude",
      cwd: f.directory,
      skillMounts: [{ directory: f.directory }],
    }),
  ).rejects.toThrow(/only skills/);
  await expect(
    f.client.createSession({
      provider: "claude",
      cwd: f.directory,
      skillMounts: [{ directory: path.join(f.directory, "missing") }],
    }),
  ).rejects.toThrow(/skill mount/i);
  expect(f.queryFactory).not.toHaveBeenCalled();
});

test("history-only resume tolerates unavailable mounts but cannot start without validating them", async () => {
  const f = await fixture();
  const handle = {
    provider: "claude",
    sessionId: "history-only",
    metadata: { cwd: f.directory, skillMounts: [{ directory: path.join(f.directory, "missing") }] },
  };
  const session = await f.client.resumeSession(handle, undefined, undefined, {
    purpose: "history",
  });
  cleanups.push(() => session.close());
  expect(f.queryFactory).not.toHaveBeenCalled();
  await expect(session.run("Try to run")).rejects.toThrow(/skill mount/i);
  expect(f.queryFactory).not.toHaveBeenCalled();
});
