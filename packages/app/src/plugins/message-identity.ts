import type { PluginMessageProps, PluginMessageReference } from "@getpaseo/plugin/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { StreamItem } from "@/types/stream";

export function validMessageReference(reference: PluginMessageReference): boolean {
  const validId = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  return (
    !!reference &&
    (reference.role === "user" || reference.role === "assistant") &&
    (validId(reference.providerMessageId) || validId(reference.clientMessageId)) &&
    (reference.providerMessageId === undefined || validId(reference.providerMessageId)) &&
    (reference.clientMessageId === undefined || validId(reference.clientMessageId)) &&
    (reference.turnId === undefined || validId(reference.turnId))
  );
}

export function matchesMessageReference(
  item: Pick<AgentTimelineItem, "type"> & { messageId?: string; clientMessageId?: string },
  turnId: string | undefined,
  reference: PluginMessageReference,
): boolean {
  return (
    validMessageReference(reference) &&
    item.type === `${reference.role}_message` &&
    (reference.providerMessageId === undefined || item.messageId === reference.providerMessageId) &&
    (reference.clientMessageId === undefined ||
      item.clientMessageId === reference.clientMessageId) &&
    (reference.turnId === undefined || turnId === reference.turnId)
  );
}

/** No optimistic messages, synthetic row ids, content hashes, or tool text become references. */
export function pluginMessageFor(item: StreamItem): PluginMessageProps["message"] | null {
  if (item.kind !== "user_message" && item.kind !== "assistant_message") return null;
  if (!item.timelineCursor) return null;
  const clientMessageId = item.kind === "user_message" ? item.clientMessageId : undefined;
  if (!item.messageId && !clientMessageId) return null;
  const identity = item.messageId
    ? { providerMessageId: item.messageId, ...(clientMessageId ? { clientMessageId } : {}) }
    : { clientMessageId: clientMessageId! };
  return Object.freeze({
    reference: Object.freeze({
      role: item.kind === "user_message" ? "user" : "assistant",
      ...identity,
      ...(item.turnId ? { turnId: item.turnId } : {}),
    }),
    text: item.text,
    position: Object.freeze({ ...item.timelineCursor }),
  });
}

export function messageReferenceKey(reference: PluginMessageReference): string {
  return JSON.stringify([
    reference.role,
    reference.providerMessageId,
    reference.clientMessageId,
    reference.turnId,
  ]);
}
