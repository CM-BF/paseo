import type {
  PluginSurfaceProps,
  PluginLocateMessageInput,
  PluginLocateMessageResult,
} from "@getpaseo/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import { isHttpUrl } from "@/utils/http-url";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";

interface HostWorkspace {
  id: string;
  root: string;
}

type WorkspaceConnection = Pick<
  HostRuntimeSnapshot,
  "client" | "clientGeneration" | "connectionEpoch" | "connectionStatus"
>;

export interface PluginFileWorkspaceAccess {
  resolve(): HostWorkspace | null;
  refresh(): Promise<void>;
}

/** A cold lookup must not navigate after its host reconnects or its plugin surface closes. */
export function capturePluginFileWorkspace(input: {
  isActive(): boolean;
  connection(): WorkspaceConnection | null;
  resolve(): HostWorkspace | null;
  refresh(): Promise<void>;
}): PluginFileWorkspaceAccess {
  const captured = input.connection();
  return {
    refresh: input.refresh,
    resolve() {
      const current = input.connection();
      const sameConnection =
        captured &&
        current &&
        captured.client === current.client &&
        captured.clientGeneration === current.clientGeneration &&
        captured.connectionEpoch === current.connectionEpoch &&
        captured.connectionStatus === current.connectionStatus;
      if (!input.isActive() || !sameConnection) {
        throw new Error("The plugin navigation host changed. Try again.");
      }
      return input.resolve();
    },
  };
}

interface HostNavigationOwner {
  browserAvailable: boolean;
  locateMessage?(input: PluginLocateMessageInput): Promise<PluginLocateMessageResult>;
  beforeNavigate?(): void;
  openAgent(input: { serverId: string; agentId: string }): void;
  openWorkspace(input: NavigateToWorkspaceInput): void;
  resolveWorkspace(input: { serverId: string; workspaceId: string }): HostWorkspace | null;
  captureFileWorkspace(input: { serverId: string; workspaceId: string }): PluginFileWorkspaceAccess;
  createBrowser(input: { initialUrl: string }): { browserId: string };
}

export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return {
    locateMessage: owner.locateMessage,
    openAgent: ({ agentId, serverId: targetServerId }) => {
      owner.beforeNavigate?.();
      owner.openAgent({ serverId: targetServerId ?? serverId, agentId });
    },
    openWorkspace: ({ workspaceId, serverId: targetServerId }) => {
      owner.beforeNavigate?.();
      owner.openWorkspace({ serverId: targetServerId ?? serverId, workspaceId });
    },
    openFile: async ({ workspaceId, path, serverId: targetServerId }) => {
      const destinationServerId = targetServerId ?? serverId;
      const access = owner.captureFileWorkspace({ serverId: destinationServerId, workspaceId });
      let workspace = access.resolve();
      if (!workspace) {
        await access.refresh();
        workspace = access.resolve();
      }
      if (!workspace) throw new Error("Workspace is unavailable on the requested host.");
      const paths = resolveWorkspaceFilePaths({ path, workspaceRoot: workspace.root });
      if (!paths?.relativePath) throw new Error("File path must be inside the workspace.");
      owner.beforeNavigate?.();
      owner.openWorkspace({
        serverId: destinationServerId,
        workspaceId: workspace.id,
        target: { kind: "file", path: paths.relativePath },
      });
    },
    openBrowser: owner.browserAvailable
      ? ({ url, workspaceId, serverId: targetServerId }) => {
          if (!isHttpUrl(url)) throw new Error("Only absolute HTTP(S) URLs are supported.");
          if (!workspaceId.trim()) throw new Error("workspaceId is required.");
          const destinationServerId = targetServerId ?? serverId;
          const workspace = owner.resolveWorkspace({
            serverId: destinationServerId,
            workspaceId,
          });
          if (!workspace) throw new Error("Workspace is unavailable on the requested host.");
          owner.beforeNavigate?.();
          const { browserId } = owner.createBrowser({ initialUrl: url });
          owner.openWorkspace({
            serverId: destinationServerId,
            workspaceId: workspace.id,
            target: { kind: "browser", browserId },
          });
        }
      : undefined,
  };
}
