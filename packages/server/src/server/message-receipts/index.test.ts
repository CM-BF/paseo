import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MessageReceipts } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new MessageReceipts(directory) };
}

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new MessageReceipts(directory).send(input);
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test.each(["cancelled", "changed", "unavailable"] as const)(
  "exact-turn cancel persists %s and rejects a changed target after reconstruction",
  async (status) => {
    const { requests, directory } = await fixture();
    let calls = 0;
    const input = {
      agentId: "agent",
      messageId: "cancel",
      request: { operation: "cancel-turn", expectedTurnId: "A" },
      send: async () => {
        calls++;
        return { status };
      },
    };
    await expect(
      Promise.all([requests.cancelTurn(input), requests.cancelTurn(input)]),
    ).resolves.toEqual([{ status }, { status }]);
    await expect(new MessageReceipts(directory).cancelTurn(input)).resolves.toEqual({ status });
    await expect(
      requests.cancelTurn({ ...input, request: { ...input.request, expectedTurnId: "B" } }),
    ).rejects.toThrow("agent_request_key_conflict");
    expect(calls).toBe(1);
  },
);

test("an ambiguous exact cancel stays pending after reconstruction without stopping twice", async () => {
  const { requests, directory } = await fixture();
  let calls = 0;
  const input = {
    agentId: "agent",
    messageId: "cancel",
    request: { operation: "cancel-turn", expectedTurnId: "A" },
    send: async () => {
      calls++;
      throw new Error("lost cancel ACK");
    },
  };
  await expect(requests.cancelTurn(input)).rejects.toThrow("lost cancel ACK");
  await expect(new MessageReceipts(directory).cancelTurn(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(calls).toBe(1);
});

test("failed local message preparation does not leave an ambiguous receipt", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    prepare: async () => {
      if (!available) throw new Error("load failed");
    },
    send: async () => {
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("load failed");
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test.each(["accepted", "unavailable", "changed"] as const)(
  "exact-turn retries replay the persisted %s result after a lost acknowledgement",
  async (status) => {
    const { requests, directory } = await fixture();
    let deliveries = 0;
    let preparations = 0;
    const input = {
      agentId: "agent",
      messageId: "steer",
      request: { operation: "steer", text: "follow up", expectedTurnId: "turn-A" },
      prepare: async () => {
        preparations++;
      },
      send: async () => {
        deliveries++;
        return { status };
      },
    };
    await expect(Promise.all([requests.steer(input), requests.steer(input)])).resolves.toEqual([
      { status },
      { status },
    ]);
    await expect(new MessageReceipts(directory).steer(input)).resolves.toEqual({ status });
    expect({ deliveries, preparations }).toEqual({ deliveries: 1, preparations: 1 });
    await expect(
      requests.steer({ ...input, request: { ...input.request, expectedTurnId: "turn-B" } }),
    ).rejects.toThrow("agent_request_key_conflict");
    await expect(
      requests.steer({ ...input, request: { ...input.request, text: "different" } }),
    ).rejects.toThrow("agent_request_key_conflict");
    await expect(
      requests.send({ ...input, request: { text: "follow up" }, send: async () => {} }),
    ).rejects.toThrow("agent_request_key_conflict");
    expect(deliveries).toBe(1);
  },
);

test.each([
  { status: "accepted" as const, turnId: "turn-A" },
  { status: "busy" as const },
  { status: "unavailable" as const },
])(
  "send-if-idle persists $status across lost acknowledgements without dispatching again",
  async (result) => {
    const { requests, directory } = await fixture();
    let deliveries = 0;
    const input = {
      agentId: "agent",
      messageId: "idle-send",
      request: { operation: "send-if-idle", text: "work" },
      send: async () => {
        deliveries++;
        return result;
      },
    };
    await expect(
      Promise.all([requests.sendIfIdle(input), requests.sendIfIdle(input)]),
    ).resolves.toEqual([result, result]);
    await expect(new MessageReceipts(directory).sendIfIdle(input)).resolves.toEqual(result);
    await expect(
      requests.sendIfIdle({
        ...input,
        request: { ...input.request, text: "changed" },
      }),
    ).rejects.toThrow("agent_request_key_conflict");
    await expect(
      requests.send({
        ...input,
        request: { text: "work" },
        send: async () => {},
      }),
    ).rejects.toThrow("agent_request_key_conflict");
    expect(deliveries).toBe(1);
  },
);

test("send-if-idle leaves ambiguous provider acceptance pending across reconstruction", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "idle-send",
    request: { operation: "send-if-idle", text: "work" },
    send: async () => {
      deliveries++;
      throw new Error("lost provider ACK");
    },
  };
  await expect(requests.sendIfIdle(input)).rejects.toThrow("lost provider ACK");
  await expect(new MessageReceipts(directory).sendIfIdle(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("ambiguous exact-turn acceptance retains a pending receipt without replay", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "steer",
    request: { operation: "steer", text: "follow up", expectedTurnId: "turn-A" },
    send: async () => {
      deliveries++;
      throw new Error("lost provider ACK");
    },
  };
  await expect(requests.steer(input)).rejects.toThrow("lost provider ACK");
  await expect(new MessageReceipts(directory).steer(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});
