import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { createPluginHostNavigation } from "./host-navigation-model";

export function usePluginHostNavigation(
  serverId: string,
  beforeNavigate?: () => void,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(
    () =>
      createPluginHostNavigation(serverId, {
        browserAvailable: getIsElectron(),
        beforeNavigate,
        openAgent: navigateToAgent,
        openWorkspace: navigateToWorkspace,
        createBrowser: createWorkspaceBrowser,
        resolveWorkspace: ({ serverId: targetServerId, workspaceId }) => {
          const workspaces = useSessionStore.getState().sessions[targetServerId]?.workspaces;
          const id = resolveWorkspaceMapKeyByIdentity({
            workspaces,
            workspaceId,
          });
          if (!id) return null;
          const workspace = workspaces?.get(id);
          return workspace ? { id, root: workspace.workspaceDirectory } : null;
        },
      }),
    [serverId, beforeNavigate],
  );
}
