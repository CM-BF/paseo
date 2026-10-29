import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  AgentTurnSteerResultSchema,
  AgentTurnCancelResultSchema,
  type AgentTurnCancelResult,
  AgentSendIfIdleResultSchema,
  type AgentTurnSteerResult,
  type AgentSendIfIdleResult,
} from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
  result: z
    .union([AgentSendIfIdleResultSchema, AgentTurnSteerResultSchema, AgentTurnCancelResultSchema])
    .optional(),
});
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<void>;
  prepare?: () => Promise<void>;
}
interface SteerMessageInput extends Omit<SendMessageInput, "send"> {
  send: () => Promise<AgentTurnSteerResult>;
}
interface IdleMessageInput extends Omit<SendMessageInput, "send"> {
  send: () => Promise<AgentSendIfIdleResult>;
}
interface CancelTurnInput extends Omit<SendMessageInput, "send"> {
  send: () => Promise<AgentTurnCancelResult>;
}
type DeliveryResult = AgentTurnSteerResult | AgentSendIfIdleResult | AgentTurnCancelResult | void;

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<DeliveryResult>>();
  constructor(private readonly directory: string) {}

  async send(input: SendMessageInput): Promise<void> {
    await this.deliver(input);
  }

  async steer(input: SteerMessageInput): Promise<AgentTurnSteerResult> {
    const result = await this.deliver(input);
    if (!result) throw new Error("agent_request_outcome_unknown");
    return AgentTurnSteerResultSchema.parse(result);
  }

  async sendIfIdle(input: IdleMessageInput): Promise<AgentSendIfIdleResult> {
    const result = await this.deliver(input);
    if (!result) throw new Error("agent_request_outcome_unknown");
    return AgentSendIfIdleResultSchema.parse(result);
  }

  async cancelTurn(input: CancelTurnInput): Promise<AgentTurnCancelResult> {
    const result = await this.deliver(input);
    if (!result) throw new Error("agent_request_outcome_unknown");
    return AgentTurnCancelResultSchema.parse(result);
  }

  private deliver(
    input: SendMessageInput | SteerMessageInput | IdleMessageInput | CancelTurnInput,
  ): Promise<DeliveryResult> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async sendOnce(
    key: string,
    input: SendMessageInput | SteerMessageInput | IdleMessageInput | CancelTurnInput,
  ): Promise<DeliveryResult> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return existing.result;
      // A provider may have accepted the message before its receipt was committed.
      throw new Error("agent_request_outcome_unknown");
    }
    await input.prepare?.();
    const receipt = { fingerprint, agentId: input.agentId };
    await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
    const result = await input.send();
    await writeJsonFileAtomic(file, {
      ...receipt,
      state: "completed",
      ...(result ? { result } : {}),
    });
    return result;
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
