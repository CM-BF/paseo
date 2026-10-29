import { describe, expect, it } from "vitest";
import { createPluginHostNavigation } from "./host-navigation-model";

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
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: electron,
      beforeNavigate: () => events.push("dismiss"),
      resolveWorkspace: ({ serverId, workspaceId }) => {
        const root = workspaces.get(`${serverId}:${workspaceId}`);
        return root ? { id: workspaceId, root } : null;
      },
      openAgent: (input) => destinations.push(input),
      openWorkspace: (input) => destinations.push(input),
      createBrowser: ({ initialUrl }) => {
        browsers.push(initialUrl);
        return { browserId: `browser-${browsers.length}` };
      },
    });
    return { navigation, destinations, browsers, workspaces, events };
  }

  it.each([true, false])(
    "opens workspace files through native navigation with Electron=%s",
    (electron) => {
      const { navigation, destinations, browsers, events } = setup(electron);
      navigation.openFile!({ workspaceId: "one", path: "docs/../report.md" });
      navigation.openFile!({ workspaceId: "one", path: "/work/one/report.md" });
      navigation.openFile!({ serverId: "remote", workspaceId: "two", path: "output/report.md" });
      navigation.openFile!({
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
  ])("rejects file path %s before dismissing or navigating", (path) => {
    const { navigation, destinations, events } = setup();
    expect(() => navigation.openFile!({ workspaceId: "one", path })).toThrow(
      "inside the workspace",
    );
    expect(destinations).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses files in missing, removed, or other-host workspaces", () => {
    const { navigation, destinations, workspaces, events } = setup();
    expect(() => navigation.openFile!({ workspaceId: "missing", path: "report.md" })).toThrow(
      "Workspace is unavailable",
    );
    expect(() =>
      navigation.openFile!({ serverId: "remote", workspaceId: "one", path: "report.md" }),
    ).toThrow("Workspace is unavailable");
    workspaces.delete("selected:one");
    expect(() => navigation.openFile!({ workspaceId: "one", path: "report.md" })).toThrow(
      "Workspace is unavailable",
    );
    expect(destinations).toEqual([]);
    expect(events).toEqual([]);
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
