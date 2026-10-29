import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useLayoutEffect, useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { capturePluginFileWorkspace, createPluginHostNavigation } from "./host-navigation-model";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

function resolveWorkspace({ serverId, workspaceId }: { serverId: string; workspaceId: string }) {
  const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
  const id = resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId });
  if (!id) return null;
  const workspace = workspaces?.get(id);
  return workspace ? { id, root: workspace.workspaceDirectory } : null;
}

export function usePluginHostNavigation(
  serverId: string,
  beforeNavigate?: () => void,
): NonNullable<PluginSurfaceProps["navigation"]> {
  const scope = useMemo(() => ({ active: false, serverId }), [serverId]);
  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  return useMemo(
    () =>
      createPluginHostNavigation(serverId, {
        browserAvailable: getIsElectron(),
        beforeNavigate,
        openAgent: navigateToAgent,
        openWorkspace: navigateToWorkspace,
        createBrowser: createWorkspaceBrowser,
        resolveWorkspace,
        captureFileWorkspace: (target) => {
          const runtime = getHostRuntimeStore();
          return capturePluginFileWorkspace({
            isActive: () => scope.active,
            connection: () => runtime.getSnapshot(target.serverId),
            resolve: () => resolveWorkspace(target),
            // DirectorySync owns response generations, cache hydration and background workspaces.
            refresh: () => runtime.refreshWorkspaceDirectory({ serverId: target.serverId }),
          });
        },
      }),
    [serverId, beforeNavigate, scope],
  );
}
