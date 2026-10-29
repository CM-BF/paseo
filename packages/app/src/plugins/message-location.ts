import type {
  PluginLocateMessageInput,
  PluginLocateMessageResult,
  PluginMessagePosition,
} from "@getpaseo/plugin/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { matchesMessageReference, validMessageReference } from "./message-identity";

const PAGE_SIZE = 200;
const MAX_PAGES = 8;
export type MessageLocationSearchResult =
  | { status: "matched"; position: PluginMessagePosition }
  | { status: "not-found" | "limit" | "unavailable" };

function searchHint(
  position: PluginMessagePosition | undefined,
): PluginMessagePosition | undefined {
  return position?.epoch &&
    Number.isSafeInteger(position.seq) &&
    position.seq >= 0 &&
    position.seq < Number.MAX_SAFE_INTEGER
    ? position
    : undefined;
}
function validPage(
  payload: Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>,
  agentId: string,
  epoch: string | undefined,
): boolean {
  return (
    payload.agentId === agentId &&
    !payload.error &&
    (epoch === undefined || epoch === payload.epoch)
  );
}

/** Bounded exact-id lookup. A cursor from an old epoch never identifies a new message. */
export async function findMessageLocation(input: {
  request: PluginLocateMessageInput;
  fetch: DaemonClient["fetchAgentTimeline"];
  isCurrent(): boolean;
}): Promise<MessageLocationSearchResult> {
  const { request } = input;
  if (!request.agentId.trim() || !validMessageReference(request.reference))
    return { status: "unavailable" };
  let cursor: PluginMessagePosition | undefined;
  let epoch: string | undefined;
  const hint = searchHint(request.position);
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (!input.isCurrent()) return { status: "unavailable" };
      const usingHint = page === 0 && hint !== undefined;
      const pageCursor = usingHint ? { epoch: hint!.epoch, seq: hint!.seq + 1 } : cursor;
      const payload = await input.fetch(request.agentId, {
        direction: pageCursor ? "before" : "tail",
        ...(pageCursor ? { cursor: pageCursor } : {}),
        limit: PAGE_SIZE,
        projection: "projected",
        timeout: 3000,
      });
      if (!input.isCurrent() || !validPage(payload, request.agentId, epoch))
        return { status: "unavailable" };
      epoch = payload.epoch;
      const entry = payload.entries.find((candidate) =>
        matchesMessageReference(candidate.item, candidate.turnId, request.reference),
      );
      if (entry) return { status: "matched", position: { epoch, seq: entry.seqEnd } };
      // A hint is not a bound on the search: it may precede the target or belong to an old epoch.
      if (usingHint) continue;
      if (!payload.hasOlder) return { status: "not-found" };
      if (!payload.startCursor || (cursor && payload.startCursor.seq >= cursor.seq))
        return { status: "unavailable" };
      cursor = payload.startCursor;
    }
    return { status: "limit" };
  } catch {
    return { status: "unavailable" };
  }
}

type Locator = (
  request: PluginLocateMessageInput,
  signal: AbortSignal,
) => Promise<PluginLocateMessageResult>;
const locators = new Map<string, Locator>();
const listeners = new Set<() => void>();
const keyFor = (serverId: string, agentId: string) => JSON.stringify([serverId, agentId]);

export function registerMessageLocator(
  serverId: string,
  agentId: string,
  locator: Locator,
): () => void {
  const key = keyFor(serverId, agentId);
  locators.set(key, locator);
  for (const listener of listeners) listener();
  return () => {
    if (locators.get(key) === locator) locators.delete(key);
  };
}

/** Waits only for the requested native transcript, never a same-id agent on another host. */
export async function requestMessageLocation(input: {
  serverId: string;
  request: PluginLocateMessageInput;
  isCurrent(): boolean;
  open(): void;
}): Promise<PluginLocateMessageResult> {
  if (!input.isCurrent() || !validMessageReference(input.request.reference))
    return { status: "unavailable" };
  const request = {
    ...input.request,
    reference: { ...input.request.reference },
    ...(input.request.position ? { position: { ...input.request.position } } : {}),
  };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 30000);
  try {
    input.open();
    const key = keyFor(input.serverId, request.agentId);
    let settle!: (value: Locator | null) => void;
    const waiting = new Promise<Locator | null>((resolve) => {
      settle = resolve;
    });
    let settled = false;
    const done = (value: Locator | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listeners.delete(check);
      controller.signal.removeEventListener("abort", aborted);
      settle(value);
    };
    const check = () => {
      if (!input.isCurrent()) return done(null);
      const value = locators.get(key);
      if (value) done(value);
    };
    const aborted = () => done(null);
    const timer = setTimeout(() => done(null), 4000);
    listeners.add(check);
    controller.signal.addEventListener("abort", aborted, { once: true });
    check();
    const locator = await waiting;
    if (!locator || !input.isCurrent()) return { status: "unavailable" };
    const result = await Promise.race([
      locator(request, controller.signal),
      new Promise<PluginLocateMessageResult>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve({ status: "unavailable" }), {
          once: true,
        }),
      ),
    ]);
    return input.isCurrent() ? result : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    controller.abort();
    clearTimeout(deadline);
  }
}
