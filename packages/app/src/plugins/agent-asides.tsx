import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type {
  PluginAgentAsideConversationProps,
  PluginAgentAsideProps,
} from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  createContext,
  useContext,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { RetainedPanelActivity, useRetainedPanelActive } from "@/components/retained-panel";
import {
  PaneFocusProvider,
  PaneProvider,
  createPaneFocusContextValue,
  usePaneFocus,
} from "@/panels/pane-context";
import { ConversationPresentationProvider } from "@/panels/conversation-presentation";
import {
  ComposerEditingScope,
  ComposerEditingSessionsProvider,
  WorkspaceComposerEditingSessionsProvider,
} from "@/composer/editing-session";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { AgentAsideAnchor, type AgentAsideOpening } from "./agent-aside-store";
import { AgentAsideFocus } from "./agent-aside-focus";
import { createAgentAsidePane } from "./agent-aside-navigation";
import { createPluginClientStateSource } from "./client-state/source";
import { usePluginHostNavigation } from "./host-navigation";
import { PluginInstallationProvider } from "./installation-provider";
import { resolvePluginPlatform } from "./platform";
import { useInstalledPlugins } from "./registry";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { toPluginTheme } from "./theme";

export interface EmbeddedAgentConversationProps {
  serverId: string;
  workspaceId: string;
  agentId: string;
}

interface ConversationBinding extends EmbeddedAgentConversationProps {
  Component: ComponentType<EmbeddedAgentConversationProps>;
}

const Binding = createContext<ConversationBinding | null>(null);

/** Stable component identity: changing plugin chrome/header never remounts the native composer. */
function BoundConversation({ streamHeader }: PluginAgentAsideConversationProps) {
  const binding = useContext(Binding);
  if (!binding) throw new Error("Conversation must render inside its agent aside");
  const presentation = useMemo(() => ({ embedded: true, streamHeader }), [streamHeader]);
  const { Component, serverId, workspaceId, agentId } = binding;
  return (
    <ConversationPresentationProvider value={presentation}>
      <Component serverId={serverId} workspaceId={workspaceId} agentId={agentId} />
    </ConversationPresentationProvider>
  );
}

interface AsideViewProps {
  anchor: AgentAsideAnchor;
  opening: AgentAsideOpening;
  NativeConversation: ComponentType<EmbeddedAgentConversationProps>;
  visible: boolean;
  focused: boolean;
  theme: PluginTheme;
}

interface AsideEditingScopeProps {
  serverId: string;
  workspaceId: string;
  agentId: string;
  tabId: string;
  children: ReactNode;
}

function AsideEditingScope({
  serverId,
  workspaceId,
  agentId,
  tabId,
  children,
}: AsideEditingScopeProps) {
  const tabIds = useMemo(() => [tabId], [tabId]);
  const targetKey = JSON.stringify({ kind: "agent", agentId });
  return (
    <ComposerEditingSessionsProvider>
      <WorkspaceComposerEditingSessionsProvider
        workspaceKey={`${serverId}:${workspaceId}`}
        tabIds={tabIds}
      >
        <ComposerEditingScope tabId={tabId} targetKey={targetKey}>
          {children}
        </ComposerEditingScope>
      </WorkspaceComposerEditingSessionsProvider>
    </ComposerEditingSessionsProvider>
  );
}

function AsideView({
  anchor,
  opening,
  NativeConversation,
  visible,
  focused,
  theme,
}: AsideViewProps) {
  const { plugin, contribution, agentId, workspaceId, params, close } = opening;
  const serverId = plugin.serverId;
  const tabId = useId();
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const label = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const state = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const viewedTimelineSync = useSessionStore(
    (sessionState) => sessionState.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  useLayoutEffect(() => {
    if (!viewedTimelineSync) return;
    const sourceId = `plugin-aside:${tabId}`;
    viewedTimelineSync.replaceVisibleAgentIds(sourceId, visible ? [agentId] : [], {
      retainWhenHidden: false,
    });
    return () =>
      viewedTimelineSync.replaceVisibleAgentIds(sourceId, [], { retainWhenHidden: false });
  }, [viewedTimelineSync, tabId, visible, agentId]);
  const scope = useMemo(() => ({ active: false, opening }), [opening]);
  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  const isCurrent = useCallback(
    () => scope.active && anchor.visible && anchor.getSnapshot().opening === opening,
    [scope, anchor, opening],
  );
  const assertCurrent = useCallback(() => {
    if (!isCurrent()) throw new Error("Conversation aside is no longer open");
  }, [isCurrent]);
  const navigation = usePluginHostNavigation(serverId, assertCurrent);
  const pane = useMemo(
    () =>
      createAgentAsidePane({
        serverId,
        workspaceId,
        agentId,
        tabId: `plugin-aside:${tabId}`,
        isCurrent,
        close,
      }),
    [serverId, workspaceId, agentId, tabId, isCurrent, close],
  );
  const binding = useMemo(
    () => ({ Component: NativeConversation, serverId, workspaceId, agentId }),
    [NativeConversation, serverId, workspaceId, agentId],
  );
  const Component = contribution.Component;
  const props: PluginAgentAsideProps = {
    theme,
    host: { id: serverId, label },
    layout: { compact, platform: resolvePluginPlatform() },
    navigation,
    parentAgentId: anchor.parentAgentId,
    agentId,
    workspaceId,
    params,
    visible,
    focused,
    close,
    Conversation: BoundConversation,
  };
  const renderError = useCallback(
    (error: string) => {
      return (
        <View style={styles.error}>
          <Text style={styles.errorText}>Conversation aside failed: {error}</Text>
          <Button onPress={close} accessibilityLabel="Close conversation aside">
            Close
          </Button>
        </View>
      );
    },
    [close],
  );
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} renderError={renderError}>
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={state}>
          <PaneProvider value={pane}>
            <AsideEditingScope
              serverId={serverId}
              workspaceId={workspaceId}
              agentId={agentId}
              tabId={pane.tabId}
            >
              <Binding value={binding}>
                <Component {...props} />
              </Binding>
            </AsideEditingScope>
          </PaneProvider>
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}
const ThemedAsideView = withUnistyles(AsideView);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

interface AgentAsideHostProps {
  serverId: string;
  parentAgentId: string;
  NativeConversation: ComponentType<EmbeddedAgentConversationProps>;
  children: ReactNode;
}

/** A retained parent owns one optional aside, without adding or retargeting a workspace tab. */
export function AgentAsideHost({
  serverId,
  parentAgentId,
  NativeConversation,
  children,
}: AgentAsideHostProps) {
  const anchor = useMemo(
    () => new AgentAsideAnchor(serverId, parentAgentId),
    [serverId, parentAgentId],
  );
  const { opening, asideFocused } = useSyncExternalStore(
    anchor.subscribe,
    anchor.getSnapshot,
    anchor.getSnapshot,
  );
  const plugins = useInstalledPlugins();
  const runtime = useHostRuntimeSnapshot(serverId);
  const parentFocus = usePaneFocus();
  const visible = useRetainedPanelActive();
  const compact = useIsCompactFormFactor();
  const available = !!runtime?.client && runtime.connectionStatus === "online";
  const validOpening =
    opening &&
    !opening.plugin.lifetime.signal.aborted &&
    plugins.some(
      (plugin) =>
        plugin.serverId === opening.plugin.serverId &&
        plugin.id === opening.plugin.id &&
        plugin.lifetime === opening.plugin.lifetime &&
        plugin.agentAsides.includes(opening.contribution),
    )
      ? opening
      : null;

  useLayoutEffect(() => anchor.mount(), [anchor]);
  useLayoutEffect(() => {
    anchor.setAvailability(visible && available, parentFocus.isInteractive);
  }, [anchor, visible, available, parentFocus.isInteractive]);
  useLayoutEffect(() => {
    anchor.close();
  }, [anchor, runtime?.client, runtime?.clientGeneration, runtime?.connectionEpoch]);
  useLayoutEffect(() => {
    if (opening && !validOpening) anchor.close(opening.token);
  }, [anchor, opening, validOpening]);

  const mainVisible = visible && !(compact && validOpening);
  const focusParentPane = parentFocus.focusPane;
  const focusMain = useCallback(() => {
    anchor.focus(false);
    focusParentPane();
  }, [anchor, focusParentPane]);
  const focusAside = useCallback(() => {
    anchor.focus(true);
    focusParentPane();
  }, [anchor, focusParentPane]);
  const mainFocus = createPaneFocusContextValue({
    isWorkspaceFocused: parentFocus.isWorkspaceFocused,
    isPaneFocused: parentFocus.isPaneFocused && mainVisible && !asideFocused,
    onFocusPane: focusMain,
  });
  const childFocus = createPaneFocusContextValue({
    isWorkspaceFocused: parentFocus.isWorkspaceFocused,
    isPaneFocused: parentFocus.isPaneFocused && visible && asideFocused,
    onFocusPane: focusAside,
  });
  return (
    <View style={styles.host}>
      <View
        style={[styles.main, !mainVisible && styles.hidden]}
        pointerEvents={mainVisible ? "auto" : "none"}
      >
        <RetainedPanelActivity active={mainVisible}>
          <PaneFocusProvider value={mainFocus}>
            <AgentAsideFocus onFocus={focusMain}>{children}</AgentAsideFocus>
          </PaneFocusProvider>
        </RetainedPanelActivity>
      </View>
      {validOpening && (
        <View style={compact ? styles.compactAside : styles.aside} testID="plugin-agent-aside">
          <RetainedPanelActivity active={visible}>
            <PaneFocusProvider value={childFocus}>
              <AgentAsideFocus onFocus={focusAside}>
                <ThemedAsideView
                  key={validOpening.key}
                  anchor={anchor}
                  opening={validOpening}
                  NativeConversation={NativeConversation}
                  visible={visible}
                  focused={childFocus.isInteractive}
                  uniProps={themeMapping}
                />
              </AgentAsideFocus>
            </PaneFocusProvider>
          </RetainedPanelActivity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  host: { flex: 1, flexDirection: "row", minWidth: 0, minHeight: 0 },
  main: { flex: 1, minWidth: 0, minHeight: 0 },
  hidden: { display: "none" },
  aside: { width: "50%", maxWidth: 448, minWidth: 0, minHeight: 0 },
  compactAside: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  error: {
    flex: 1,
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
    gap: theme.spacing[4],
  },
  errorText: { color: theme.colors.statusDanger },
}));
