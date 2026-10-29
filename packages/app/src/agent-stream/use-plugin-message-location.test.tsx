/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { PluginLocateMessageResult } from "@getpaseo/plugin/client";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "./strategy";
import { requestMessageLocation } from "@/plugins/message-location";
import { usePluginMessageLocation } from "./use-plugin-message-location";
const runtime = vi.hoisted(() => ({ fetch: vi.fn(), hydrate: vi.fn(), generation: 1 }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("@/runtime/host-runtime", () => {
  const client = { fetchAgentTimeline: runtime.fetch };
  return {
    getHostRuntimeStore: () => ({
      getSnapshot: () => ({ client, clientGeneration: runtime.generation, connectionEpoch: 1 }),
      fetchAgentTimeline: runtime.hydrate,
    }),
  };
});
const item: StreamItem = {
  kind: "assistant_message",
  id: "render-segment",
  messageId: "native",
  text: "actual",
  timestamp: new Date(),
  timelineCursor: { epoch: "epoch", seq: 4 },
};
const request = {
  agentId: "agent",
  reference: { role: "assistant" as const, providerMessageId: "native" },
};
const locate = () =>
  requestMessageLocation({ serverId: "host", request, isCurrent: () => true, open: () => {} });
beforeEach(() => {
  runtime.fetch.mockReset();
  runtime.hydrate.mockReset();
  runtime.generation = 1;
});
function fixture(initial: { items: StreamItem[]; active: boolean }, reveal = vi.fn(() => false)) {
  const viewport = createRef<StreamViewportHandle>();
  const scroll = vi.fn(async () => true);
  viewport.current = {
    scrollToBottom() {},
    prepareForViewportChange() {},
    holdReadingPosition() {},
    locateMessage: scroll,
  };
  return {
    ...renderHook(
      ({ items, active }) =>
        usePluginMessageLocation({
          serverId: "host",
          agentId: "agent",
          active,
          items,
          head: [],
          mounted: { has: () => true },
          reveal,
          viewport,
        }),
      { initialProps: initial },
    ),
    viewport,
    scroll,
    reveal,
  };
}
it("reveals a collapsed source before scrolling and resolves only after viewport confirmation", async () => {
  const reveal = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  const f = fixture({ items: [item], active: true }, reveal);
  let completed = false;
  let result!: Promise<PluginLocateMessageResult>;
  await act(async () => {
    result = locate().then((x) => {
      completed = true;
      return x;
    });
  });
  expect(f.scroll).not.toHaveBeenCalled();
  expect(completed).toBe(false);
  await act(async () => f.rerender({ items: [item], active: true }));
  expect(await result).toEqual({ status: "found" });
  expect(f.scroll).toHaveBeenCalledWith("render-segment", expect.any(AbortSignal));
  f.unmount();
});
it("late history reads cannot hydrate or scroll after view removal or reconnect", async () => {
  for (const change of ["unmount", "reconnect"]) {
    let finish!: (value: unknown) => void;
    runtime.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = fixture({ items: [], active: true });
    let result!: Promise<PluginLocateMessageResult>;
    await act(async () => {
      result = locate();
    });
    if (change === "unmount") f.unmount();
    else runtime.generation++;
    await act(async () =>
      finish({
        agentId: "agent",
        epoch: "epoch",
        entries: [{ item: { type: "assistant_message", messageId: "native" }, seqEnd: 4 }],
        hasOlder: false,
        error: null,
      }),
    );
    expect(await result).toEqual({ status: "unavailable" });
    expect(runtime.hydrate).not.toHaveBeenCalled();
    expect(f.scroll).not.toHaveBeenCalled();
    if (change !== "unmount") f.unmount();
  }
});
it("a viewport without native locate support never claims success or fetches history", async () => {
  const f = fixture({ items: [item], active: true });
  delete f.viewport.current!.locateMessage;
  expect(await locate()).toEqual({ status: "unavailable" });
  expect(runtime.fetch).not.toHaveBeenCalled();
  f.unmount();
});
