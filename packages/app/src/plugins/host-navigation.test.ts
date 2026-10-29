import { describe, expect, it } from "vitest";
import { capturePluginFileWorkspace, createPluginHostNavigation } from "./host-navigation-model";

describe("plugin host navigation", () => {
  function setup(electron = true) {
    const destinations: unknown[] = [];
    const browsers: string[] = [];
    const events: string[] = [];
    const workspaces = new Map([
      ["selected:one", "/work/one"],
      ["remote:two", "/work/two"],
      ["windows:three", "C:/work/three"],
    ]);
    let active = true,
      generation = 1,
      epoch = 1;
    let refresh: (serverId: string) => Promise<void> = async () => {};
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: electron,
      beforeNavigate: () => events.push("dismiss"),
      resolveWorkspace: ({ serverId, workspaceId }) => {
        const root = workspaces.get(`${serverId}:${workspaceId}`);
        return root ? { id: workspaceId, root } : null;
      },
      captureFileWorkspace: ({ serverId, workspaceId }) =>
        capturePluginFileWorkspace({
          isActive: () => active,
          connection: () => ({
            client: null,
            clientGeneration: generation,
            connectionEpoch: epoch,
            connectionStatus: "online",
          }),
          resolve: () => {
            const root = workspaces.get(`${serverId}:${workspaceId}`);
            return root ? { id: workspaceId, root } : null;
          },
          refresh: () => refresh(serverId),
        }),
      openAgent: (input) => destinations.push(input),
      openWorkspace: (input) => destinations.push(input),
      createBrowser: ({ initialUrl }) => {
        browsers.push(initialUrl);
        return { browserId: `browser-${browsers.length}` };
      },
    });
    return {
      navigation,
      destinations,
      browsers,
      workspaces,
      events,
      setRefresh(value: typeof refresh) {
        refresh = value;
      },
      close() {
        active = false;
      },
      replaceClient() {
        generation++;
      },
      reconnect() {
        epoch++;
      },
    };
  }

  it.each([true, false])(
    "opens workspace files through native navigation with Electron=%s",
    async (electron) => {
      const { navigation, destinations, browsers, events } = setup(electron);
      await navigation.openFile!({ workspaceId: "one", path: "docs/../report.md" });
      await navigation.openFile!({ workspaceId: "one", path: "/work/one/report.md" });
      await navigation.openFile!({
        serverId: "remote",
        workspaceId: "two",
        path: "output/report.md",
      });
      await navigation.openFile!({
        serverId: "windows",
        workspaceId: "three",
        path: "C:\\work\\three\\report.md",
      });
      expect(destinations).toEqual([
        { serverId: "selected", workspaceId: "one", target: { kind: "file", path: "report.md" } },
        { serverId: "selected", workspaceId: "one", target: { kind: "file", path: "report.md" } },
        {
          serverId: "remote",
          workspaceId: "two",
          target: { kind: "file", path: "output/report.md" },
        },
        { serverId: "windows", workspaceId: "three", target: { kind: "file", path: "report.md" } },
      ]);
      expect(events).toEqual(["dismiss", "dismiss", "dismiss", "dismiss"]);
      expect(browsers).toEqual([]);
    },
  );

  it.each([
    "",
    " ",
    ".",
    "..",
    "../escape.md",
    "dir/../../escape.md",
    "/outside/file.md",
    "/work/one-other/file.md",
    "/work/one",
    "~/file.md",
  ])("rejects file path %s before dismissing or navigating", async (path) => {
    const { navigation, destinations, events } = setup();
    await expect(navigation.openFile!({ workspaceId: "one", path })).rejects.toThrow(
      "inside the workspace",
    );
    expect(destinations).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses files in missing, removed, or other-host workspaces", async () => {
    const { navigation, destinations, workspaces, events } = setup();
    await expect(
      navigation.openFile!({ workspaceId: "missing", path: "report.md" }),
    ).rejects.toThrow("Workspace is unavailable");
    await expect(
      navigation.openFile!({ serverId: "remote", workspaceId: "one", path: "report.md" }),
    ).rejects.toThrow("Workspace is unavailable");
    workspaces.delete("selected:one");
    await expect(navigation.openFile!({ workspaceId: "one", path: "report.md" })).rejects.toThrow(
      "Workspace is unavailable",
    );
    expect(destinations).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refreshes a cold background workspace on only its named host before opening its file", async () => {
    const t = setup();
    const refreshed: string[] = [];
    t.setRefresh(async (serverId) => {
      refreshed.push(serverId);
      t.workspaces.set(`${serverId}:background`, "/work/background");
    });
    await t.navigation.openFile!({
      serverId: "remote",
      workspaceId: "background",
      path: "result.md",
    });
    expect(refreshed).toEqual(["remote"]);
    expect(t.destinations).toEqual([
      {
        serverId: "remote",
        workspaceId: "background",
        target: { kind: "file", path: "result.md" },
      },
    ]);
    expect(t.events).toEqual(["dismiss"]);
  });

  it.each(["close", "replaceClient", "reconnect"] as const)(
    "rejects a cold file lookup after %s without dismissing or navigating",
    async (change) => {
      const t = setup();
      t.setRefresh(async () => {
        t.workspaces.set("selected:cold", "/work/cold");
        t[change]();
      });
      await expect(
        t.navigation.openFile!({ workspaceId: "cold", path: "result.md" }),
      ).rejects.toThrow("host changed");
      expect(t.destinations).toEqual([]);
      expect(t.events).toEqual([]);
    },
  );

  it("surfaces directory refresh failure without navigating or closing the surface", async () => {
    const t = setup();
    t.setRefresh(async () => {
      throw new Error("Connection lost");
    });
    await expect(
      t.navigation.openFile!({ workspaceId: "cold", path: "result.md" }),
    ).rejects.toThrow("Connection lost");
    expect(t.destinations).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it("creates and focuses a local browser in the selected or explicit host workspace", () => {
    const { navigation, destinations, browsers } = setup();
    navigation.openBrowser!({ url: "https://example.com/one", workspaceId: "one" });
    navigation.openBrowser!({
      url: "https://example.com/two",
      workspaceId: "two",
      serverId: "remote",
    });
    expect(browsers).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(destinations).toEqual([
      {
        serverId: "selected",
        workspaceId: "one",
        target: { kind: "browser", browserId: "browser-1" },
      },
      {
        serverId: "remote",
        workspaceId: "two",
        target: { kind: "browser", browserId: "browser-2" },
      },
    ]);
  });

  it("dismisses the sidebar before navigating on the selected or explicitly requested host", () => {
    const events: unknown[] = [];
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: false,
      beforeNavigate: () => events.push("dismiss"),
      openAgent: (input) => events.push(input),
      openWorkspace: (input) => events.push(input),
      resolveWorkspace: () => null,
      captureFileWorkspace: () => {
        throw new Error("Not used");
      },
      createBrowser: () => {
        throw new Error("Browser unavailable");
      },
    });
    navigation.openAgent({ agentId: "companion" });
    navigation.openAgent({ agentId: "companion", serverId: "remote" });
    navigation.openWorkspace({ workspaceId: "project" });
    expect(events).toEqual([
      "dismiss",
      { serverId: "selected", agentId: "companion" },
      "dismiss",
      { serverId: "remote", agentId: "companion" },
      "dismiss",
      { serverId: "selected", workspaceId: "project" },
    ]);
  });

  it("refuses unknown or removed workspaces before creating browser records", () => {
    const { navigation, destinations, browsers, workspaces } = setup();
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "missing" }),
    ).toThrow("Workspace is unavailable");
    expect(() =>
      navigation.openBrowser!({
        url: "https://example.com",
        workspaceId: "one",
        serverId: "unknown",
      }),
    ).toThrow("Workspace is unavailable");
    workspaces.delete("selected:one");
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "one" }),
    ).toThrow("Workspace is unavailable");
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it("exposes no browser capability outside Electron and creates no tabs", () => {
    const { navigation, destinations, browsers } = setup(false);
    expect(navigation.openBrowser).toBeUndefined();
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it.each(["javascript:alert(1)", "file:///tmp/file", "/relative", "invalid"])(
    "rejects %s before creating a browser",
    (url) => {
      const { navigation, browsers, destinations } = setup();
      expect(() => navigation.openBrowser!({ url, workspaceId: "one" })).toThrow("HTTP(S)");
      expect(browsers).toEqual([]);
      expect(destinations).toEqual([]);
    },
  );

  it("rejects an empty workspace before creating a browser", () => {
    const { navigation, browsers } = setup();
    expect(() => navigation.openBrowser!({ url: "https://example.com", workspaceId: "" })).toThrow(
      "workspaceId",
    );
    expect(browsers).toEqual([]);
  });
});
