import type { PaneContextValue } from "@/panels/pane-context";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

interface EmbeddedPaneInput {
  serverId: string;
  workspaceId: string;
  agentId: string;
  tabId: string;
  isCurrent(): boolean;
  close(): void;
}

/** Never inherits the parent's tab identity or callbacks. Explicit navigation opens a new target. */
export function createAgentAsidePane(input: EmbeddedPaneInput): PaneContextValue {
  const { serverId, workspaceId, agentId, tabId, isCurrent, close } = input;
  function assertCurrent() {
    if (!isCurrent()) throw new Error("Conversation aside is no longer open");
  }
  function openTarget(target: WorkspaceTabTarget) {
    assertCurrent();
    if (target.kind === "agent") {
      navigateToAgent({ serverId, agentId: target.agentId });
      return;
    }
    navigateToWorkspace({ serverId, workspaceId, target });
  }
  function unsupported() {
    assertCurrent();
    throw new Error("Replacing or importing a conversation inside an aside is unavailable");
  }
  return {
    serverId,
    workspaceId,
    host: "main",
    tabId,
    target: { kind: "agent", agentId },
    openTab: openTarget,
    openPreferredTarget: openTarget,
    openTargetToSide: openTarget,
    closeCurrentTab() {
      assertCurrent();
      close();
    },
    retargetCurrentTab: unsupported,
    setCurrentTabState: unsupported,
    openImportSheet: unsupported,
    openFileInWorkspace(request) {
      openTarget({ kind: "file", ...request.location });
    },
  };
}
