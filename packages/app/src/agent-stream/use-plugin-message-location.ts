import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PluginLocateMessageInput, PluginLocateMessageResult } from "@getpaseo/plugin/client";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { matchesMessageReference } from "@/plugins/message-identity";
import { findMessageLocation, registerMessageLocator } from "@/plugins/message-location";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "./strategy";

interface PendingLocation {
  scrolling?: boolean;
  request: PluginLocateMessageInput;
  signal: AbortSignal;
  resolve(result: PluginLocateMessageResult): void;
  isCurrent(): boolean;
}

export function usePluginMessageLocation(input: {
  serverId: string;
  agentId: string;
  active: boolean;
  items: StreamItem[];
  head: StreamItem[] | undefined;
  mounted: { has(id: string): boolean };
  reveal(id: string): boolean;
  viewport: RefObject<StreamViewportHandle | null>;
}) {
  const scope = useMemo(
    () => ({ active: input.active, serverId: input.serverId, agentId: input.agentId }),
    [input.serverId, input.agentId, input.active],
  );
  useEffect(() => {
    scope.active = input.active;
    return () => {
      scope.active = false;
    };
  }, [scope, input.active]);
  const [pending, setPending] = useState<PendingLocation | null>(null);
  const current = useRef<PendingLocation | null>(null);
  const requestSequence = useRef(0);
  const find = useStableEvent((request: PluginLocateMessageInput) => {
    return [...input.items, ...(input.head ?? [])].find(
      (item) =>
        (item.kind === "user_message" || item.kind === "assistant_message") &&
        item.timelineCursor &&
        matchesMessageReference({ ...item, type: item.kind }, item.turnId, request.reference),
    );
  });
  const locate = useStableEvent(
    async (
      request: PluginLocateMessageInput,
      signal: AbortSignal,
    ): Promise<PluginLocateMessageResult> => {
      if (!isWeb || !input.active || !input.viewport.current?.locateMessage)
        return { status: "unavailable" };
      const sequence = ++requestSequence.current;
      current.current?.resolve({ status: "unavailable" });
      const runtime = getHostRuntimeStore();
      const captured = runtime.getSnapshot(input.serverId);
      if (!captured) return { status: "unavailable" };
      const client = captured.client;
      const isCurrent = () => {
        const now = runtime.getSnapshot(input.serverId);
        return (
          !!now &&
          sequence === requestSequence.current &&
          !signal.aborted &&
          scope.active &&
          captured.client === now.client &&
          captured.clientGeneration === now.clientGeneration &&
          captured.connectionEpoch === now.connectionEpoch
        );
      };
      if (!client || !isCurrent()) return { status: "unavailable" };
      if (!find(request)) {
        const result = await findMessageLocation({
          request,
          fetch: client.fetchAgentTimeline.bind(client),
          isCurrent,
        });
        if (result.status !== "matched") return result;
        if (!isCurrent()) return { status: "unavailable" };
        try {
          await runtime.fetchAgentTimeline(
            input.serverId,
            input.agentId,
            planTimelinePromptJump(result.position),
          );
        } catch {
          return { status: "unavailable" };
        }
      }
      if (!isCurrent()) return { status: "unavailable" };
      return new Promise((resolve) => {
        current.current?.resolve({ status: "unavailable" });
        const operation: PendingLocation = {
          request,
          signal,
          isCurrent,
          resolve(result) {
            signal.removeEventListener("abort", abort);
            if (current.current === operation) {
              current.current = null;
              setPending(null);
            }
            resolve(result);
          },
        };
        const abort = () => operation.resolve({ status: "unavailable" });
        signal.addEventListener("abort", abort, { once: true });
        current.current = operation;
        setPending(operation);
      });
    },
  );
  useEffect(() => {
    if (!input.active) return;
    const remove = registerMessageLocator(input.serverId, input.agentId, locate);
    return () => {
      remove();
      current.current?.resolve({ status: "unavailable" });
    };
  }, [input.serverId, input.agentId, input.active, locate]);
  useEffect(() => {
    if (!pending || pending.scrolling) return;
    if (!pending.isCurrent()) return pending.resolve({ status: "unavailable" });
    const target = find(pending.request);
    if (!target) return;
    const id = getStreamItemMessageId(target);
    if (input.reveal(id)) return;
    if (!input.mounted.has(id)) return;
    const viewport = input.viewport.current;
    if (!viewport?.locateMessage) return pending.resolve({ status: "unavailable" });
    pending.scrolling = true;
    void viewport
      .locateMessage(id, pending.signal)
      .then((found) => {
        return pending.resolve({ status: pending.isCurrent() && found ? "found" : "unavailable" });
      })
      .catch(() => pending.resolve({ status: "unavailable" }));
  }, [pending, find, input]);
}
