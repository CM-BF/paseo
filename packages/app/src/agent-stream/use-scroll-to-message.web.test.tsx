/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useScrollToMessage } from "./use-scroll-to-message.web";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
const rect = (top: number, bottom: number) => ({
  top,
  bottom,
  left: 0,
  right: 500,
  width: 500,
  height: bottom - top,
  x: 0,
  y: top,
  toJSON() {
    return {};
  },
});
function setup() {
  vi.stubGlobal("CSS", { escape: (value: string) => value.replaceAll('"', '\\"') });
  // Exercise the actual web lookup and scroll with a mounted DOM; geometry is explicit in jsdom.
  const container = document.createElement("div");
  document.body.appendChild(container);
  container.getBoundingClientRect = () => rect(0, 500);
  Object.defineProperties(container, {
    clientHeight: { value: 500 },
    scrollHeight: { value: 1000 },
  });
  const scrollToIndex = vi.fn();
  const hook = renderHook(() =>
    useScrollToMessage({
      active: true,
      scrollContainerRef: { current: container },
      rowVirtualizer: { scrollToIndex } as unknown as Virtualizer<HTMLElement, Element>,
      historyVirtualized: [
        {
          kind: "assistant_message",
          id: "actual",
          messageId: "native",
          text: "same",
          timestamp: new Date(),
        },
      ],
      cancelPendingStickToBottom: vi.fn(),
      setFollowOutput: () => true,
      onNearBottomChange: vi.fn(),
    }),
  );
  return { ...hook, container, scrollToIndex };
}
it("confirms only the exact mounted visible row, then highlights it", async () => {
  const f = setup();
  const row = document.createElement("div");
  row.dataset.messageId = "actual";
  row.getBoundingClientRect = () => rect(100, 200);
  const animate = vi.fn();
  row.animate = animate;
  f.container.appendChild(row);
  let found = false;
  await act(async () => {
    found = await f.result.current.locateMessage("actual", new AbortController().signal);
  });
  expect(found).toBe(true);
  expect(animate).toHaveBeenCalledTimes(1);
  expect(f.container.scrollTop).not.toBe(0);
  f.unmount();
});
it("a cancelled lookup cannot treat another row or an absent row as located", async () => {
  const f = setup();
  const row = document.createElement("div");
  row.dataset.messageId = "other";
  row.getBoundingClientRect = () => rect(100, 200);
  f.container.appendChild(row);
  const controller = new AbortController();
  let pending!: Promise<boolean>;
  act(() => {
    pending = f.result.current.locateMessage("actual", controller.signal);
    controller.abort();
  });
  expect(await pending).toBe(false);
  expect(f.scrollToIndex).toHaveBeenCalledWith(0, { align: "start" });
  f.unmount();
});
