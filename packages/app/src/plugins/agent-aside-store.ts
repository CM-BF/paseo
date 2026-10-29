import type {
  PluginAgentAsideContribution,
  PluginAgentAsideHandle,
  PluginOpenAgentAsideInput,
  PluginScreenParams,
} from "@getpaseo/plugin/client";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { InstalledPlugin } from "./types";

export interface AgentAsideOpening {
  readonly key: number;
  readonly plugin: InstalledPlugin;
  readonly contribution: PluginAgentAsideContribution;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly params: Readonly<PluginScreenParams>;
  readonly token: object;
  close(): void;
}

interface AgentAsideState {
  opening: AgentAsideOpening | null;
  asideFocused: boolean;
}

const anchors = new Set<AgentAsideAnchor>();
let nextOpeningKey = 0;

/** One mounted native parent surface. No persisted tabs, agent mutations, or transcript copies. */
export class AgentAsideAnchor {
  private listeners = new Set<() => void>();
  private state: AgentAsideState = { opening: null, asideFocused: false };
  private generation = 0;
  private removeLifetimeListener: (() => void) | undefined;
  visible = false;
  focused = false;

  constructor(
    readonly serverId: string,
    readonly parentAgentId: string,
  ) {}

  mount(): () => void {
    anchors.add(this);
    return () => {
      anchors.delete(this);
      this.generation++;
      this.close();
    };
  }

  setAvailability(visible: boolean, focused: boolean): void {
    if (this.visible && !visible) this.generation++;
    this.visible = visible;
    this.focused = focused;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AgentAsideState => this.state;

  private publish(state: AgentAsideState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  focus(asideFocused: boolean): void {
    if (this.state.asideFocused === asideFocused) return;
    this.publish({ ...this.state, asideFocused });
  }

  close(token?: object): void {
    if (token && this.state.opening?.token !== token) return;
    this.generation++;
    this.removeLifetimeListener?.();
    this.removeLifetimeListener = undefined;
    if (this.state.opening) this.publish({ opening: null, asideFocused: false });
  }

  reserve(): () => boolean {
    const generation = ++this.generation;
    return () => anchors.has(this) && this.visible && this.generation === generation;
  }

  show(input: Omit<AgentAsideOpening, "key" | "token" | "close">): PluginAgentAsideHandle {
    this.removeLifetimeListener?.();
    const token = {};
    const close = () => this.close(token);
    const signal = input.plugin.lifetime.signal;
    signal.addEventListener("abort", close, { once: true });
    this.removeLifetimeListener = () => signal.removeEventListener("abort", close);
    this.publish({
      opening: { ...input, key: ++nextOpeningKey, token, close },
      asideFocused: true,
    });
    return { close };
  }
}

function findAnchor(serverId: string, parentAgentId: string): AgentAsideAnchor {
  const visible = [...anchors].filter(
    (anchor) =>
      anchor.serverId === serverId && anchor.parentAgentId === parentAgentId && anchor.visible,
  );
  const anchor = visible.find((candidate) => candidate.focused) ?? visible.at(-1);
  if (!anchor) throw new Error("Open the parent conversation before opening its aside");
  return anchor;
}

function captureParams(params: PluginScreenParams | undefined): Readonly<PluginScreenParams> {
  if (!params) return Object.freeze({});
  if (Object.values(params).some((value) => typeof value !== "string")) {
    throw new Error("Agent aside params must contain only string values");
  }
  if (JSON.stringify(params).length > 65536) throw new Error("Agent aside params are too large");
  return Object.freeze({ ...params });
}

export async function openPluginAgentAside(
  plugin: InstalledPlugin,
  input: PluginOpenAgentAsideInput,
): Promise<PluginAgentAsideHandle> {
  const contribution = plugin.agentAsides.find((item) => item.id === input.id);
  if (!contribution || plugin.lifetime.signal.aborted) {
    throw new Error("Agent aside contribution is unavailable");
  }
  if (!input.agentId.trim() || input.agentId === input.parentAgentId) {
    throw new Error("An agent aside needs a different, existing child agent");
  }
  const params = captureParams(input.params);
  const anchor = findAnchor(plugin.serverId, input.parentAgentId);
  const isCurrent = anchor.reserve();
  const runtime = getHostRuntimeStore();
  const captured = runtime.getSnapshot(plugin.serverId);
  if (!captured?.client || captured.connectionStatus !== "online") {
    throw new Error("Agent aside host is offline");
  }
  const result = await captured.client.fetchAgent({ agentId: input.agentId });
  const current = runtime.getSnapshot(plugin.serverId);
  if (
    !isCurrent() ||
    plugin.lifetime.signal.aborted ||
    !plugin.agentAsides.includes(contribution) ||
    current?.client !== captured.client ||
    current.clientGeneration !== captured.clientGeneration ||
    current.connectionEpoch !== captured.connectionEpoch ||
    current.connectionStatus !== "online"
  ) {
    throw new Error("Agent aside target changed while opening");
  }
  if (!result || result.agent.id !== input.agentId || !result.agent.workspaceId) {
    throw new Error("Agent aside child or workspace is unavailable");
  }
  return anchor.show({
    plugin,
    contribution,
    agentId: result.agent.id,
    workspaceId: result.agent.workspaceId,
    params,
  });
}
