import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgentTurnReceiptSchema, type AgentTurnReceipt } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";

/** Durable observations, independent of runtime liveness and message-delivery receipts. */
export class AgentTurnReceipts {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly bindings = new Map<string, string | null>();

  constructor(private readonly directory: string) {}

  async get(agentId: string, turnId: string): Promise<AgentTurnReceipt> {
    const key = this.key(agentId, turnId);
    await this.tails.get(key)?.catch(() => undefined);
    return this.read(agentId, turnId);
  }

  accepted(agentId: string, turnId: string, clientMessageId?: string): Promise<void> {
    const key = this.key(agentId, turnId);
    // Retain this binding if the initial write fails but a later terminal write succeeds.
    this.bindings.set(key, clientMessageId ?? null);
    return this.mutate(key, async () => {
      const existing = await this.read(agentId, turnId);
      if (existing.clientMessageId && existing.clientMessageId !== clientMessageId) {
        throw new Error("agent_turn_identity_conflict");
      }
      if (existing.status !== "unknown") return;
      await this.write(key, { ...existing, clientMessageId: clientMessageId ?? null });
      this.bindings.delete(key);
    });
  }

  terminal(
    agentId: string,
    turnId: string,
    status: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    const key = this.key(agentId, turnId);
    return this.mutate(key, async () => {
      const existing = await this.read(agentId, turnId);
      // The first exact terminal observation wins, including across daemon restarts.
      if (existing.status !== "unknown") return;
      await this.write(key, {
        agentId,
        turnId,
        clientMessageId: existing.clientMessageId ?? this.bindings.get(key) ?? null,
        status,
        observedAt: new Date().toISOString(),
      });
      this.bindings.delete(key);
    });
  }

  private mutate(key: string, operation: () => Promise<void>): Promise<void> {
    const next = (this.tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.tails.set(key, next);
    void next
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      })
      .catch(() => undefined);
    return next;
  }

  private key(agentId: string, turnId: string): string {
    return createHash("sha256")
      .update(JSON.stringify([agentId, turnId]))
      .digest("hex");
  }

  private write(key: string, receipt: AgentTurnReceipt): Promise<void> {
    return writeJsonFileAtomic(path.join(this.directory, `${key}.json`), receipt);
  }

  private async read(agentId: string, turnId: string): Promise<AgentTurnReceipt> {
    try {
      const receipt = AgentTurnReceiptSchema.parse(
        JSON.parse(
          await readFile(path.join(this.directory, `${this.key(agentId, turnId)}.json`), "utf8"),
        ),
      );
      if (receipt.agentId !== agentId || receipt.turnId !== turnId) {
        throw new Error("agent_turn_identity_conflict");
      }
      return receipt;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return { agentId, turnId, clientMessageId: null, status: "unknown" };
    }
  }
}
