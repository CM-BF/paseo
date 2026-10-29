/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginAgentAsideHandle } from "@getpaseo/plugin/client";
import appPackage from "../../package.json";
import { RetainedPanelActivity, useRetainedPanelActive } from "@/components/retained-panel";
import {
  PaneFocusProvider,
  createPaneFocusContextValue,
  usePaneContext,
  usePaneFocus,
} from "@/panels/pane-context";
import { useConversationPresentation } from "@/panels/conversation-presentation";
import {
  ComposerEditingScope,
  ComposerEditingSessionsProvider,
  WorkspaceComposerEditingSessionsProvider,
  useComposerEditingSession,
  useComposerFullscreen,
} from "@/composer/editing-session";

const fixtures = vi.hoisted(() => ({
  compact: false,
  epoch: 1,
  fetch: vi.fn(async (input: { agentId: string }) => ({
    agent: { id: input.agentId, workspaceId: `workspace:${input.agentId}` },
  })),
  navigate: vi.fn(),
  chromeNavigation: new Array<(input: { agentId: string }) => void>(),
}));
vi.mock("@/runtime/host-runtime", () => {
  const client = { fetchAgent: fixtures.fetch };
  function snapshot() {
    return {
      client,
      clientGeneration: 1,
      connectionEpoch: fixtures.epoch,
      connectionStatus: "online",
    };
  }
  return {
    getHostRuntimeStore: () => ({ getSnapshot: snapshot }),
    useHostRuntimeSnapshot: snapshot,
    useHosts: () => [],
  };
});
vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => fixtures.compact,
}));
vi.mock("./client-runtime", () => ({
  createPluginClientRuntime: () => ({
    paseo: {},
    rpc: async () => {},
    openSurface: () => {},
    openPanel: () => {},
    addComposerPill: () => ({ update() {}, remove() {} }),
    addHeaderButton: () => ({ update() {}, remove() {} }),
  }),
}));
vi.mock("./host-navigation", () => ({
  usePluginHostNavigation: (_serverId: string, beforeNavigate?: () => void) => {
    function openAgent(input: { agentId: string }) {
      beforeNavigate?.();
      fixtures.navigate(input);
    }
    fixtures.chromeNavigation.push(openAgent);
    return { openAgent, openWorkspace: openAgent };
  },
}));
vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: (...args: unknown[]) => fixtures.navigate(...args),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: (...args: unknown[]) => fixtures.navigate(...args),
}));
// Exercise the browser's keyboard/pointer focus boundary instead of the native touch adapter.
vi.mock("./agent-aside-focus", () => import("./agent-aside-focus.web"));

import { AgentAsideHost, type EmbeddedAgentConversationProps } from "./agent-asides";
import { openPluginAgentAside } from "./agent-aside-store";
import { pluginRegistry } from "./registry";

const bundle = `(function(require) {
  const React = require("react");
  return { default: function(plugin) {
    plugin.addAgentAside({ id: "topic", Component: function(props) {
      const [count, setCount] = React.useState(0);
      if (props.params.broken) throw new Error("fixture failure");
      return React.createElement("section", {"data-testid":"chrome"},
        React.createElement("button", {onClick:props.close}, "Close topic"),
        React.createElement("button", {onClick:()=>setCount(count+1)}, "Change header"),
        React.createElement("output", null, [props.host.id,props.parentAgentId,props.agentId,props.workspaceId,props.visible,props.focused].join("/")),
        React.createElement(props.Conversation, {streamHeader:React.createElement("p", null, "Root context " + count)}));
    }});
    return function() {};
  }};
})`;
let root: Root;
let container: HTMLDivElement;
const nativeCallbacks: Array<ReturnType<typeof usePaneContext>> = [];
let nativeMounts = 0;

function NativeConversation(props: EmbeddedAgentConversationProps) {
  const pane = usePaneContext();
  const focus = usePaneFocus();
  const visible = useRetainedPanelActive();
  const { embedded, streamHeader } = useConversationPresentation();
  const editing = useComposerEditingSession("chat");
  const fullscreen = useComposerFullscreen(editing);
  const expand = React.useCallback(() => editing.setFullscreen(true), [editing]);
  const [draft, setDraft] = React.useState("child draft");
  const changeDraft = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    [],
  );
  const openToolFile = React.useCallback(
    () => pane.openFileInWorkspace({ location: { path: "tool-output.txt" }, disposition: "main" }),
    [pane],
  );
  React.useEffect(() => {
    nativeMounts++;
    nativeCallbacks.push(pane);
  }, [pane]);
  return (
    <article data-testid="native-conversation">
      {streamHeader}
      <output>
        {JSON.stringify({
          ...props,
          target: pane.target,
          tabId: pane.tabId,
          focused: focus.isInteractive,
          visible,
          embedded,
        })}
      </output>
      <input value={draft} onChange={changeDraft} />
      <button type="button" onClick={expand}>
        Child fullscreen {String(fullscreen)}
      </button>
      <button type="button" onClick={openToolFile}>
        Open tool file
      </button>
    </article>
  );
}
function Parent() {
  const focus = usePaneFocus();
  const visible = useRetainedPanelActive();
  const editing = useComposerEditingSession("chat");
  const fullscreen = useComposerFullscreen(editing);
  return (
    <div>
      <button type="button" data-testid="parent">
        Parent {String(focus.isInteractive)}/{String(visible)}
      </button>
      <output>Parent fullscreen {String(fullscreen)}</output>
    </div>
  );
}
const parentTabIds = ["parent-tab"];
function render(serverId = "host-A", parentAgentId = "parent", visible = true) {
  act(() =>
    root.render(
      <RetainedPanelActivity active={visible}>
        <PaneFocusProvider
          value={createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true })}
        >
          <ComposerEditingSessionsProvider>
            <WorkspaceComposerEditingSessionsProvider
              workspaceKey={`${serverId}:parent-workspace`}
              tabIds={parentTabIds}
            >
              <ComposerEditingScope tabId="parent-tab" targetKey="parent-agent">
                <AgentAsideHost
                  serverId={serverId}
                  parentAgentId={parentAgentId}
                  NativeConversation={NativeConversation}
                >
                  <Parent />
                </AgentAsideHost>
              </ComposerEditingScope>
            </WorkspaceComposerEditingSessionsProvider>
          </ComposerEditingSessionsProvider>
        </PaneFocusProvider>
      </RetainedPanelActivity>,
    ),
  );
}
function install(serverId = "host-A", id = "topics") {
  pluginRegistry.installCatalog(
    serverId,
    [{ id, requirements: { paseo: ">=" + appPackage.version }, clientBundle: bundle }],
    {
      client: new DaemonClient({ url: "ws://unused.test", clientId: "agent-aside-test" }),
      audio: { play: async () => 0 },
    },
  );
  const plugin = pluginRegistry
    .getSnapshot()
    .find((item) => item.serverId === serverId && item.id === id);
  if (!plugin) throw new Error("Fixture plugin did not install");
  return plugin;
}
async function open(agentId = "child", plugin = pluginRegistry.getSnapshot()[0]) {
  let handle: PluginAgentAsideHandle | undefined;
  await act(async () => {
    handle = await openPluginAgentAside(plugin, { id: "topic", parentAgentId: "parent", agentId });
  });
  if (!handle) throw new Error("Missing open receipt");
  return handle;
}
function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  act(() => button.click());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixtures.compact = false;
  fixtures.epoch = 1;
  fixtures.fetch.mockReset().mockImplementation(async ({ agentId }) => ({
    agent: { id: agentId, workspaceId: `workspace:${agentId}` },
  }));
  fixtures.navigate.mockReset();
  fixtures.chromeNavigation.length = 0;
  nativeCallbacks.length = 0;
  nativeMounts = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  pluginRegistry.removeHost("host-A");
  pluginRegistry.removeHost("host-B");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("binds chrome, native child pane and same-scroll header without changing the parent target", async () => {
  install();
  render();
  await open();
  const native = container.querySelector('[data-testid="native-conversation"]');
  expect(native?.textContent).toContain("Root context 0");
  expect(native?.textContent).toContain('"agentId":"child"');
  expect(native?.textContent).toContain('"workspaceId":"workspace:child"');
  expect(native?.textContent).toContain('"embedded":true');
  expect(native?.textContent).toContain('"focused":true');
  expect(container.querySelector('[data-testid="parent"]')?.textContent).toBe("Parent false/true");
  const mounts = nativeMounts;
  click("Change header");
  expect(nativeMounts).toBe(mounts);
  expect(container.querySelector("input")?.value).toBe("child draft");
  expect(native?.textContent).toContain("Root context 1");
  click("Open tool file");
  expect(fixtures.navigate).toHaveBeenCalledWith({
    serverId: "host-A",
    workspaceId: "workspace:child",
    target: { kind: "file", path: "tool-output.txt" },
  });
  click("Close topic");
  expect(container.querySelector('[data-testid="native-conversation"]')).toBeNull();
  expect(container.querySelector('[data-testid="parent"]')?.textContent).toBe("Parent true/true");
  expect(fixtures.fetch).toHaveBeenCalledTimes(1);
});

it("retains the parent on compact layouts while giving only the aside visible input ownership", async () => {
  fixtures.compact = true;
  install();
  render();
  await open();
  expect(container.querySelector('[data-testid="parent"]')?.textContent).toBe("Parent false/false");
  render("host-A", "parent", false);
  expect(container.querySelector('[data-testid="native-conversation"]')?.textContent).toContain(
    '"visible":false',
  );
  expect(container.querySelector('[data-testid="native-conversation"]')?.textContent).toContain(
    '"focused":false',
  );
  render();
  expect(container.querySelector('[data-testid="native-conversation"]')?.textContent).toContain(
    '"visible":true',
  );
});

it("isolates the child's actual composer editing session and keyboard focus from the parent", async () => {
  install();
  render();
  await open();
  click("Child fullscreen false");
  expect(container.textContent).toContain("Child fullscreen true");
  expect(container.textContent).toContain("Parent fullscreen false");
  const parent = container.querySelector<HTMLButtonElement>('[data-testid="parent"]');
  if (!parent) throw new Error("Missing parent");
  act(() => parent.focus());
  expect(parent.textContent).toBe("Parent true/true");
  expect(container.querySelector('[data-testid="native-conversation"]')?.textContent).toContain(
    '"focused":false',
  );
  const input = container.querySelector("input");
  if (!input) throw new Error("Missing child input");
  act(() => input.focus());
  expect(parent.textContent).toBe("Parent false/true");
  expect(container.querySelector('[data-testid="native-conversation"]')?.textContent).toContain(
    '"focused":true',
  );
});

it("rejects an opening whose parent was switched before child lookup completed", async () => {
  const plugin = install();
  render();
  const pending = deferred<Awaited<ReturnType<typeof fixtures.fetch>>>();
  fixtures.fetch.mockReturnValueOnce(pending.promise);
  const opening = openPluginAgentAside(plugin, {
    id: "topic",
    parentAgentId: "parent",
    agentId: "child",
  });
  const result = expect(opening).rejects.toThrow("target changed");
  render("host-A", "other-parent");
  await act(async () =>
    pending.resolve({ agent: { id: "child", workspaceId: "workspace:child" } }),
  );
  await result;
  expect(container.querySelector('[data-testid="native-conversation"]')).toBeNull();
});

it("rejects a stale host epoch and does not cross host identity", async () => {
  const plugin = install();
  install("host-B");
  render();
  const pending = deferred<Awaited<ReturnType<typeof fixtures.fetch>>>();
  fixtures.fetch.mockReturnValueOnce(pending.promise);
  const opening = openPluginAgentAside(plugin, {
    id: "topic",
    parentAgentId: "parent",
    agentId: "child",
  });
  const result = expect(opening).rejects.toThrow("target changed");
  fixtures.epoch++;
  render("host-B");
  await act(async () =>
    pending.resolve({ agent: { id: "child", workspaceId: "workspace:child" } }),
  );
  await result;
  const pluginB = pluginRegistry.getSnapshot().find((item) => item.serverId === "host-B");
  if (!pluginB) throw new Error("Missing host-B installation");
  await open("child-B", pluginB);
  expect(container.textContent).toContain("host-B/parent/child-B/workspace:child-B");
});

it("keeps newer openings safe from stale close and native navigation callbacks", async () => {
  install();
  render();
  const first = await open("child-1");
  const oldPane = nativeCallbacks[0];
  const oldChromeNavigation = fixtures.chromeNavigation[0];
  await open("child-2");
  act(() => first.close());
  expect(container.textContent).toContain("child-2");
  expect(() => oldPane.openTab({ kind: "agent", agentId: "another" })).toThrow("no longer open");
  expect(() => oldChromeNavigation({ agentId: "another" })).toThrow("no longer open");
  expect(fixtures.navigate).not.toHaveBeenCalled();
});

it("keeps the last requested child when lookups finish out of order", async () => {
  const plugin = install();
  render();
  const pending = deferred<Awaited<ReturnType<typeof fixtures.fetch>>>();
  fixtures.fetch.mockReturnValueOnce(pending.promise);
  const first = openPluginAgentAside(plugin, {
    id: "topic",
    parentAgentId: "parent",
    agentId: "old-child",
  });
  const rejected = expect(first).rejects.toThrow("target changed");
  await open("new-child", plugin);
  await act(async () =>
    pending.resolve({ agent: { id: "old-child", workspaceId: "workspace:old-child" } }),
  );
  await rejected;
  expect(container.textContent).toContain("new-child");
  expect(container.textContent).not.toContain("old-child");
});

it("removes native UI on contribution removal and rejects old open requests after teardown", async () => {
  const plugin = install();
  render();
  await open();
  await act(async () => plugin.cleanup());
  expect(container.querySelector('[data-testid="native-conversation"]')).toBeNull();
  await expect(
    openPluginAgentAside(plugin, { id: "topic", parentAgentId: "parent", agentId: "child" }),
  ).rejects.toThrow("unavailable");
});

it("closes on installation abort without a child lifecycle mutation", async () => {
  const plugin = install();
  render();
  await open();
  act(() => plugin.lifetime.abort());
  expect(container.querySelector('[data-testid="native-conversation"]')).toBeNull();
  expect(fixtures.fetch).toHaveBeenCalledTimes(1);
  expect(fixtures.navigate).not.toHaveBeenCalled();
});

it("contains plugin render errors with an independent usable close action", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const plugin = install();
  render();
  await act(async () => {
    await openPluginAgentAside(plugin, {
      id: "topic",
      parentAgentId: "parent",
      agentId: "child",
      params: { broken: "true" },
    });
  });
  expect(container.textContent).toContain("fixture failure");
  click("Close");
  expect(container.querySelector('[data-testid="plugin-agent-aside"]')).toBeNull();
});

it("validates parent anchor, registered contribution and distinct child before showing UI", async () => {
  const plugin = install();
  await expect(
    openPluginAgentAside(plugin, { id: "topic", parentAgentId: "parent", agentId: "child" }),
  ).rejects.toThrow("Open the parent");
  render();
  await expect(
    openPluginAgentAside(plugin, { id: "unknown", parentAgentId: "parent", agentId: "child" }),
  ).rejects.toThrow("unavailable");
  await expect(
    openPluginAgentAside(plugin, { id: "topic", parentAgentId: "parent", agentId: "parent" }),
  ).rejects.toThrow("different");
  expect(fixtures.fetch).not.toHaveBeenCalled();
});
