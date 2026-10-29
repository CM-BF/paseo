import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture(
  options: {
    resume?: boolean;
    catalog?: boolean;
    unsupported?: boolean;
    mount?: boolean;
    history?: boolean;
  } = {},
) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "codex-mount-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, ".claude-plugin"));
  await mkdir(path.join(directory, "skills", "fixture"), { recursive: true });
  await writeFile(path.join(directory, ".claude-plugin", "plugin.json"), '{"name":"fixture"}');
  const skillPath = path.join(directory, "skills", "fixture", "SKILL.md");
  await writeFile(skillPath, "---\nname: fixture\ndescription: Fixture\n---\nBody.");
  const server = createFakeCodexAppServer({
    "skills/extraRoots/set": () =>
      options.unsupported ? { __jsonRpcError: { code: -32601, message: "Method not found" } } : {},
    "skills/list": () => ({
      data: [
        {
          skills:
            options.catalog === false
              ? []
              : [{ name: "fixture", description: "Fixture", path: skillPath, enabled: true }],
        },
      ],
    }),
    "thread/resume": () => ({ thread: { id: "thread-1", turns: [] } }),
  });
  const spawn = vi.fn(async () => server.child);
  const config = {
    provider: "codex",
    cwd: directory,
    ...(options.mount === false ? {} : { skillMounts: [{ directory }] }),
  };
  const session = new CodexAppServerAgentSession(
    config,
    options.resume ? { sessionId: "thread-1" } : null,
    createTestLogger(),
    spawn,
    {},
    false,
    false,
    false,
    undefined,
    options.history ? "history" : "interactive",
  );
  cleanups.push(() => session.close());
  return { session, server, directory, spawn, config };
}

test.each([false, true])(
  "sets and verifies skill roots before native admission (resume=%s)",
  async (resume) => {
    const f = await fixture({ resume });
    await f.session.connect();
    if (!resume) await f.session.startTurn("Use the fixture skill");
    const calls = f.server.requests();
    const methods = calls.map((call) => call.method);
    const set = methods.indexOf("skills/extraRoots/set");
    expect(calls[set]).toMatchObject({
      params: { extraRoots: [path.join(f.directory, "skills")] },
    });
    expect(set).toBeGreaterThan(methods.indexOf("initialized"));
    expect(methods.indexOf("skills/list")).toBeGreaterThan(set);
    expect(methods.indexOf(resume ? "thread/resume" : "thread/start")).toBeGreaterThan(
      methods.indexOf("skills/list"),
    );
    expect(f.session.describePersistence()?.metadata?.skillMounts).toEqual([
      { directory: f.directory },
    ]);
    f.server.assertNoErrors();
  },
);

test.each([{ catalog: false }, { unsupported: true }])(
  "rejects a mount before native resume when unavailable: %j",
  async (options) => {
    const f = await fixture({ ...options, resume: true });
    await expect(f.session.connect()).rejects.toThrow();
    expect(
      f.server
        .requests()
        .some((call) =>
          ["thread/start", "thread/resume", "turn/start"].includes(String(call.method)),
        ),
    ).toBe(false);
    f.server.assertNoErrors();
  },
);

test("missing projections fail before spawning; unmounted agents never set roots", async () => {
  const f = await fixture();
  await rm(path.join(f.directory, "skills"), { recursive: true });
  await expect(f.session.connect()).rejects.toThrow(/skill mount/i);
  expect(f.spawn).not.toHaveBeenCalled();
  const other = await fixture({ mount: false });
  await other.session.connect();
  expect(other.server.requests().some((call) => call.method === "skills/extraRoots/set")).toBe(
    false,
  );
});

test("history-only reads neither require missing mounts nor resume a native thread", async () => {
  const f = await fixture({ resume: true, history: true });
  await rm(path.join(f.directory, "skills"), { recursive: true });
  await f.session.connect();
  expect(
    f.server
      .requests()
      .some((call) =>
        ["skills/extraRoots/set", "thread/resume", "turn/start"].includes(String(call.method)),
      ),
  ).toBe(false);
  expect(f.server.requests().some((call) => call.method === "thread/read")).toBe(true);
  f.server.assertNoErrors();
});
