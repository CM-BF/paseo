/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import appPackage from "../../package.json";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("./host-navigation", () => ({
  usePluginHostNavigation: (serverId: string) => ({
    openAgent: (input: object) => navigate({ serverId, ...input }),
    openWorkspace: () => {},
  }),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => ({}), useHosts: () => [] }));
vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
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
import { pluginRegistry } from "./registry";
import { PluginMessageItems } from "./message-items";

const roots: Array<ReturnType<typeof createRoot>> = [];
const containers: HTMLElement[] = [];
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  navigate.mockReset();
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  pluginRegistry.removeHost("host-A");
  pluginRegistry.removeHost("host-B");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const bundle = `(function(require) {
  const React = require("react");
  return { default: function(plugin) {
    plugin.addMessageAction({ id: "owner", Component: function(props) {
      const first = React.useState(props.agentId)[0];
      const source = React.useState(props.message.reference.providerMessageId)[0];
      if (props.agentId === "ordinary") return null;
      if (props.agentId === "broken") throw new Error("owner failed");
      return React.createElement("button", { onClick: function() { props.navigation.openAgent({agentId:props.agentId}); } },
        [props.host.id, source, props.agentId, first].join("/"));
    }});
    return function() {};
  }};
})`;
function install(host: string) {
  pluginRegistry.installCatalog(
    host,
    [{ id: "owners", requirements: { paseo: ">=" + appPackage.version }, clientBundle: bundle }],
    {
      client: {} as DaemonClient,
      audio: { play: async () => 0 },
    },
  );
}
const message = (id: string) => ({
  reference: { role: "assistant" as const, providerMessageId: id },
  text: "native content",
  position: { epoch: "epoch", seq: 1 },
});
function fixture() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  return { container, root };
}
it("keeps host, source message and native agent identity aligned and remounts on agent changes", async () => {
  install("host-A");
  install("host-B");
  const { root, container } = fixture();
  await act(async () =>
    root.render(
      <PluginMessageItems
        serverId="host-A"
        message={message("source-A")}
        slot="action"
        agentId="agent-A"
      />,
    ),
  );
  expect(container.textContent).toBe("host-A/source-A/agent-A/agent-A");
  await act(async () => container.querySelector("button")!.click());
  expect(navigate).toHaveBeenLastCalledWith({ serverId: "host-A", agentId: "agent-A" });
  await act(async () =>
    root.render(
      <PluginMessageItems
        serverId="host-B"
        message={message("source-B")}
        slot="action"
        agentId="agent-B"
      />,
    ),
  );
  expect(container.textContent).toBe("host-B/source-B/agent-B/agent-B");
  await act(async () => container.querySelector("button")!.click());
  expect(navigate).toHaveBeenLastCalledWith({ serverId: "host-B", agentId: "agent-B" });
  await act(async () =>
    root.render(
      <PluginMessageItems
        serverId="host-B"
        message={message("source-B")}
        slot="action"
        agentId="agent-C"
      />,
    ),
  );
  expect(container.textContent).toBe("host-B/source-B/agent-C/agent-C");
  await act(async () =>
    root.render(
      <PluginMessageItems
        serverId="host-B"
        message={message("new-source")}
        slot="action"
        agentId="agent-C"
      />,
    ),
  );
  expect(container.textContent).toBe("host-B/new-source/agent-C/agent-C");
});
it("adds no button chrome for null content and contains a failing contribution", async () => {
  install("host-A");
  const { root, container } = fixture();
  await act(async () =>
    root.render(
      <PluginMessageItems
        serverId="host-A"
        message={message("source")}
        slot="action"
        agentId="ordinary"
      />,
    ),
  );
  expect(container.textContent).toBe("");
  expect(container.querySelector("button")).toBeNull();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () =>
    root.render(
      <div>
        Title
        <PluginMessageItems
          serverId="host-A"
          message={message("source")}
          slot="action"
          agentId="broken"
        />
      </div>,
    ),
  );
  expect(container.textContent).toBe("Title");
  await act(async () =>
    root.render(
      <PluginMessageItems
        serverId="host-A"
        message={message("source")}
        slot="action"
        agentId="recovered"
      />,
    ),
  );
  expect(container.textContent).toBe("host-A/source/recovered/recovered");
  await act(async () => pluginRegistry.removeHost("host-A"));
  expect(container.textContent).toBe("");
});
