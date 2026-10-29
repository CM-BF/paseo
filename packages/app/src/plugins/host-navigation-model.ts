import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import { isHttpUrl } from "@/utils/http-url";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

interface HostWorkspace {
  id: string;
  root: string;
}

interface HostNavigationOwner {
  browserAvailable: boolean;
  beforeNavigate?(): void;
  openAgent(input: { serverId: string; agentId: string }): void;
  openWorkspace(input: NavigateToWorkspaceInput): void;
  resolveWorkspace(input: { serverId: string; workspaceId: string }): HostWorkspace | null;
  createBrowser(input: { initialUrl: string }): { browserId: string };
}

export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return {
    openAgent: ({ agentId, serverId: targetServerId }) => {
      owner.beforeNavigate?.();
      owner.openAgent({ serverId: targetServerId ?? serverId, agentId });
    },
    openWorkspace: ({ workspaceId, serverId: targetServerId }) => {
      owner.beforeNavigate?.();
      owner.openWorkspace({ serverId: targetServerId ?? serverId, workspaceId });
    },
    openFile: ({ workspaceId, path, serverId: targetServerId }) => {
      const destinationServerId = targetServerId ?? serverId;
      const workspace = owner.resolveWorkspace({ serverId: destinationServerId, workspaceId });
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
