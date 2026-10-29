import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { pluginMessageFor, matchesMessageReference } from "./message-identity";
import {
  findMessageLocation,
  registerMessageLocator,
  requestMessageLocation,
} from "./message-location";

const reference = { role: "user" as const, clientMessageId: "client-1" };
const request = { agentId: "agent", reference };
type Page = Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>;
function page(input: Partial<Page> = {}): Page {
  return {
    agentId: "agent",
    epoch: "epoch",
    entries: [],
    hasOlder: false,
    error: null,
    ...input,
  } as Page;
}
const entry = (id: string, seq: number) =>
  ({
    provider: "codex",
    item: {
      type: "user_message",
      text: "identical text",
      clientMessageId: id,
      messageId: `provider-${id}`,
    },
    seqStart: seq,
    seqEnd: seq,
    timestamp: "2026-01-01T00:00:00Z",
    sourceSeqRanges: [],
    collapsed: [],
  }) as Page["entries"][number];

describe("plugin message identities", () => {
  it("never promotes local row ids or text hashes into source identities", () => {
    const item = {
      kind: "user_message" as const,
      id: "local-row",
      text: "hello",
      timestamp: new Date(),
    };
    expect(pluginMessageFor(item)).toBeNull();
    expect(pluginMessageFor({ ...item, clientMessageId: "pending" })).toBeNull();
    expect(pluginMessageFor({ ...item, timelineCursor: { epoch: "epoch", seq: 1 } })).toBeNull();
    const source = pluginMessageFor({
      ...item,
      messageId: "native",
      clientMessageId: "sent",
      timelineCursor: { epoch: "epoch", seq: 1 },
    })!;
    expect(source.reference).toEqual({
      role: "user",
      providerMessageId: "native",
      clientMessageId: "sent",
    });
    expect(Object.isFrozen(source.reference)).toBe(true);
    expect(
      matchesMessageReference(
        { type: "user_message", messageId: "native", clientMessageId: "other" },
        undefined,
        source.reference,
      ),
    ).toBe(false);
    expect(
      matchesMessageReference({ type: "assistant_message", messageId: "native" }, undefined, {
        role: "user",
        providerMessageId: "native",
      }),
    ).toBe(false);
  });
});

describe("bounded native message lookup", () => {
  it("treats the position as a hint and verifies identity, role and turn", async () => {
    const fetch = vi
      .fn<DaemonClient["fetchAgentTimeline"]>()
      .mockResolvedValueOnce(page({ entries: [entry("other", 10)] }))
      .mockResolvedValueOnce(page({ entries: [entry("client-1", 20)] }));
    expect(
      await findMessageLocation({
        request: { ...request, position: { epoch: "old", seq: 10 } },
        fetch,
        isCurrent: () => true,
      }),
    ).toEqual({ status: "matched", position: { epoch: "epoch", seq: 20 } });
    expect(fetch.mock.calls.map((call) => call[1]?.direction)).toEqual(["before", "tail"]);
  });
  it("does not search another agent or accept a host reconnection or epoch replacement", async () => {
    for (const response of [
      page({ agentId: "other", entries: [entry("client-1", 1)] }),
      page({ epoch: "replacement", entries: [entry("client-1", 1)] }),
    ]) {
      const fetch = vi
        .fn<DaemonClient["fetchAgentTimeline"]>()
        .mockResolvedValueOnce(page({ hasOlder: true, startCursor: { epoch: "epoch", seq: 20 } }))
        .mockResolvedValueOnce(response);
      expect(await findMessageLocation({ request, fetch, isCurrent: () => true })).toEqual({
        status: "unavailable",
      });
    }
    let current = true;
    const fetch = vi.fn<DaemonClient["fetchAgentTimeline"]>().mockImplementation(async () => {
      current = false;
      return page({ entries: [entry("client-1", 1)] });
    });
    expect(await findMessageLocation({ request, fetch, isCurrent: () => current })).toEqual({
      status: "unavailable",
    });
  });
  it("distinguishes not found from a bounded-history limit", async () => {
    const missing = vi.fn<DaemonClient["fetchAgentTimeline"]>().mockResolvedValue(page());
    expect(await findMessageLocation({ request, fetch: missing, isCurrent: () => true })).toEqual({
      status: "not-found",
    });
    let seq = 2000;
    const fetch = vi
      .fn<DaemonClient["fetchAgentTimeline"]>()
      .mockImplementation(async () =>
        page({ hasOlder: true, startCursor: { epoch: "epoch", seq: (seq -= 200) } }),
      );
    expect(await findMessageLocation({ request, fetch, isCurrent: () => true })).toEqual({
      status: "limit",
    });
    expect(fetch).toHaveBeenCalledTimes(8);
  });
});

it("waits for the exact host/agent view, rejects stale callbacks and removes locators", async () => {
  const wrong = vi.fn(async () => ({ status: "found" as const }));
  const removeWrong = registerMessageLocator("other", "agent", wrong);
  const right = vi.fn(async () => ({ status: "not-found" as const }));
  let remove = () => {};
  const open = vi.fn(() => {
    remove = registerMessageLocator("host", "agent", right);
  });
  expect(
    await requestMessageLocation({ serverId: "host", request, isCurrent: () => true, open }),
  ).toEqual({ status: "not-found" });
  expect(wrong).not.toHaveBeenCalled();
  expect(right).toHaveBeenCalledTimes(1);
  remove();
  removeWrong();
  const staleOpen = vi.fn();
  expect(
    await requestMessageLocation({
      serverId: "host",
      request,
      isCurrent: () => false,
      open: staleOpen,
    }),
  ).toEqual({ status: "unavailable" });
  expect(staleOpen).not.toHaveBeenCalled();
});
