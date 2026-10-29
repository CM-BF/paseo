/** @vitest-environment jsdom */
import React, { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Composer } from "@/composer";
import { CLIENT_SLASH_COMMANDS } from "@/client-slash-commands";
import { ComposerEditingSession } from "@/composer/editing-session";
import { submitClientSlashCommand } from "@/composer/submit";
import { PaneProvider } from "./pane-context";
import { ConversationPresentationProvider } from "./conversation-presentation";
import { createAgentAsidePane } from "@/plugins/agent-aside-navigation";
import { ToastApiProvider } from "@/contexts/toast-api-context";

const actions = vi.hoisted(() => ({
  archive: vi.fn(),
  clear: vi.fn(),
  close: vi.fn(),
  navigate: vi.fn(),
}));
const toast = { show: () => () => {}, copied() {}, error() {} };
const presentation = { embedded: true };
let composerProps: ComponentProps<typeof Composer> | undefined;
vi.mock("@/composer", () => ({
  Composer(props: ComponentProps<typeof Composer>) {
    composerProps = props;
    return (
      <output>
        {props.serverId}/{props.agentId}/{props.workspaceId}/{props.textSource.getSnapshot()}
      </output>
    );
  },
}));
vi.mock("@/hooks/use-archive-agent", () => ({
  useArchiveAgent: () => ({ archiveAgent: actions.archive, isArchivingAgent: () => false }),
}));
// This test mounts the native composer owner; the surrounding transcript/draft panels are unused.
vi.mock("@/agent-stream/view", () => ({ AgentStreamView: () => null }));
vi.mock("@/composer/dock", () => ({ ComposerDock: () => null }));
vi.mock("@/composer/draft/workspace-tab", () => ({ WorkspaceDraftAgentTab: () => null }));
vi.mock("@/components/file-drop/file-drop-zone", () => ({ FileDropZone: () => null }));
vi.mock("@/plugins", () => ({ useHasPluginComposerPills: () => false }));
vi.mock("@/panels/agent-tracks", () => ({ AgentTracks: () => null, hasAgentTracks: () => false }));
vi.mock("@/subagents/parent", () => ({
  ParentAgentCallout: () => null,
  useParentAgentId: () => null,
}));
vi.mock("@/attachments/service", () => ({ garbageCollectAttachments: async () => {} }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({}),
  useHostRuntimeClient: () => null,
  useHostRuntimeConnectionStatus: () => "offline",
  useHostRuntimeIsConnected: () => false,
  useHostRuntimeLastError: () => null,
  useHostRuntimeSnapshot: () => null,
  useHosts: () => [],
}));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: actions.navigate }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: actions.navigate,
}));
import { ActiveAgentComposer } from "./agent-panel";

function createDraft(text: string): ComponentProps<typeof ActiveAgentComposer>["agentInputDraft"] {
  return {
    textSource: { getSnapshot: () => text, subscribe: () => () => {} },
    editText() {},
    replaceText() {},
    textReplacement: { kind: "initial", key: "child-draft", text },
    attachments: [],
    setAttachments() {},
    clear: actions.clear,
    isHydrated: true,
    attachmentFocusRequestId: 0,
    composerState: null,
  };
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  composerProps = undefined;
  Object.values(actions).forEach((fn) => fn.mockReset());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

it.each(CLIENT_SLASH_COMMANDS)(
  "rejects /$name before clearing the child draft or touching a parent tab",
  async (command) => {
    const pane = createAgentAsidePane({
      serverId: "host-A",
      workspaceId: "child-workspace",
      agentId: "child",
      tabId: "aside-tab",
      isCurrent: () => true,
      close: actions.close,
    });
    const editingSession = new ComposerEditingSession();
    const draft = createDraft(`/${command.name}`);
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastApiProvider api={toast}>
            <PaneProvider value={pane}>
              <ConversationPresentationProvider value={presentation}>
                <ActiveAgentComposer
                  agentId="child"
                  serverId="host-A"
                  isPaneFocused
                  cwd="/child"
                  isSubmitLoading={false}
                  agentInputDraft={draft}
                  editingSession={editingSession}
                  onAttentionInputFocus={actions.clear}
                  onAttentionPromptSend={actions.clear}
                  onComposerHeightChange={actions.clear}
                  onMessageSent={actions.clear}
                />
              </ConversationPresentationProvider>
            </PaneProvider>
          </ToastApiProvider>
        </QueryClientProvider>,
      ),
    );
    const props = composerProps;
    if (!props) throw new Error("Native composer did not receive props");
    const error = vi.fn();
    const processing = vi.fn();
    expect(
      submitClientSlashCommand({
        command,
        beforeCommand: props.beforeClientSlashCommand,
        onCommand: props.onClientSlashCommand,
        clear: () => props.clearDraft("sent"),
        setError: error,
        setProcessing: processing,
      }),
    ).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Your draft is preserved"));
    expect(processing).not.toHaveBeenCalled();
    expect(actions.clear).not.toHaveBeenCalled();
    expect(container.textContent).toBe(`host-A/child/child-workspace//${command.name}`);
    // Retained/direct callbacks cannot skip the preflight and mutate the native lifecycle either.
    await expect(props.onClientSlashCommand?.(command)).rejects.toThrow("unavailable");
    expect(actions.archive).not.toHaveBeenCalled();
    expect(actions.close).not.toHaveBeenCalled();
    expect(actions.navigate).not.toHaveBeenCalled();
  },
);
