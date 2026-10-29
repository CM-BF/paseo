/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { registerMessageLocator } from "./message-location";
import { usePluginHostNavigation } from "./host-navigation";

const host = vi.hoisted(() => ({
  workspaces: new Map<string, { id: string; workspaceDirectory: string }>(),
  client: {},
  generation: 1,
  refresh: vi.fn<(input: { serverId: string }) => Promise<void>>(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({
      client: host.client,
      clientGeneration: host.generation,
      connectionEpoch: 1,
      connectionStatus: "online",
    }),
    refreshWorkspaceDirectory: host.refresh,
  }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({ sessions: { "host-1": { workspaces: host.workspaces } } }),
  },
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: vi.fn(),
}));

const navigateToAgentMock = vi.mocked(navigateToAgent);
const navigateToWorkspaceMock = vi.mocked(navigateToWorkspace);

describe("usePluginHostNavigation", () => {
  beforeEach(() => {
    navigateToAgentMock.mockReset();
    navigateToWorkspaceMock.mockReset();
    host.workspaces.clear();
    host.refresh.mockReset();
  });

  it("opens agents and workspaces on the rendering host", () => {
    const { result } = renderHook(() => usePluginHostNavigation("host-1"));

    act(() => result.current.openAgent({ agentId: "agent-1" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-1" }));

    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-1", agentId: "agent-1" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-1",
      workspaceId: "workspace-1",
    });
  });

  it("keeps the capability stable until the rendering host changes", () => {
    const { result, rerender } = renderHook(({ serverId }) => usePluginHostNavigation(serverId), {
      initialProps: { serverId: "host-1" },
    });
    const initialNavigation = result.current;

    rerender({ serverId: "host-1" });
    expect(result.current).toBe(initialNavigation);

    rerender({ serverId: "host-2" });
    expect(result.current).not.toBe(initialNavigation);

    act(() => result.current.openAgent({ agentId: "agent-2" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-2" }));
    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-2", agentId: "agent-2" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-2",
      workspaceId: "workspace-2",
    });
  });

  it("opens a newly hydrated background workspace through the real hook", async () => {
    host.refresh.mockImplementation(async () => {
      host.workspaces.set("background", { id: "background", workspaceDirectory: "/owned/work" });
    });
    const { result } = renderHook(() => usePluginHostNavigation("host-1"));
    await act(() => result.current.openFile!({ workspaceId: "background", path: "report.md" }));
    expect(host.refresh).toHaveBeenCalledWith({ serverId: "host-1" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-1",
      workspaceId: "background",
      target: { kind: "file", path: "report.md" },
    });
  });

  it.each(["unmount", "switch"])(
    "does not navigate a late file lookup after %s",
    async (change) => {
      let finish!: () => void;
      host.refresh.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const { result, unmount, rerender } = renderHook(
        ({ serverId }) => usePluginHostNavigation(serverId),
        {
          initialProps: { serverId: "host-1" },
        },
      );
      const opening = result.current.openFile!({ workspaceId: "background", path: "report.md" });
      const rejected = expect(opening).rejects.toThrow("host changed");
      if (change === "unmount") unmount();
      else rerender({ serverId: "host-2" });
      host.workspaces.set("background", { id: "background", workspaceDirectory: "/owned/work" });
      finish();
      await rejected;
      expect(navigateToWorkspaceMock).not.toHaveBeenCalled();
    },
  );
});

it("rejects message callbacks from unmounted or previous-host surfaces", async () => {
  const { result, rerender, unmount } = renderHook(
    ({ serverId }) => usePluginHostNavigation(serverId),
    { initialProps: { serverId: "host-1" } },
  );
  const first = result.current.locateMessage!;
  const request = {
    agentId: "agent",
    reference: { role: "user" as const, clientMessageId: "client" },
  };
  rerender({ serverId: "host-2" });
  expect(await first(request)).toEqual({ status: "unavailable" });
  const second = result.current.locateMessage!;
  unmount();
  expect(await second(request)).toEqual({ status: "unavailable" });
  expect(navigateToAgentMock).not.toHaveBeenCalled();
});
it("rejects a message location result from a replaced connection", async () => {
  let finish!: (value: { status: "found" }) => void;
  const remove = registerMessageLocator(
    "host-1",
    "agent",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, unmount } = renderHook(() => usePluginHostNavigation("host-1"));
  let pending!: ReturnType<NonNullable<typeof result.current.locateMessage>>;
  await act(async () => {
    pending = result.current.locateMessage!({
      agentId: "agent",
      reference: { role: "user", clientMessageId: "id" },
    });
  });
  host.generation++;
  finish({ status: "found" });
  expect(await pending).toEqual({ status: "unavailable" });
  remove();
  unmount();
});
