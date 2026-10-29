import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type {
  PluginAgentHeaderItemContribution,
  PluginAgentHeaderItemProps,
} from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "./client-state/source";
import { usePluginHostNavigation } from "./host-navigation";
import { PluginInstallationProvider } from "./installation-provider";
import { resolvePluginPlatform } from "./platform";
import { useInstalledPlugins } from "./registry";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { toPluginTheme } from "./theme";
import type { InstalledPlugin } from "./types";

interface AgentHeaderContext {
  serverId: string;
  workspaceId: string;
  agentId: string;
}
const noError = () => null;
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function Item({
  plugin,
  item,
  workspaceId,
  agentId,
  theme,
}: AgentHeaderContext & {
  plugin: InstalledPlugin;
  item: PluginAgentHeaderItemContribution;
  theme: PluginTheme;
}) {
  const serverId = plugin.serverId;
  const compact = useIsCompactFormFactor(),
    hosts = useHosts();
  const label = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label }), [serverId, label]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const navigation = usePluginHostNavigation(serverId);
  const state = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const Component = item.Component;
  const props: PluginAgentHeaderItemProps = {
    theme,
    host,
    layout,
    navigation,
    workspaceId,
    agentId,
  };
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} renderError={noError}>
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={state}>
          <Component {...props} />
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}

function Items({
  serverId,
  workspaceId,
  agentId,
  theme,
}: AgentHeaderContext & { theme: PluginTheme }) {
  const plugins = useInstalledPlugins();
  const client = useHostRuntimeClient(serverId);
  if (!client) return null;
  const items = plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) => plugin.agentHeaderItems.map((item) => ({ plugin, item })));
  if (!items.length) return null;
  return (
    <View style={styles.items}>
      {items.map(({ plugin, item }) => (
        <Item
          key={`${serverId}:${workspaceId}:${agentId}:${plugin.id}:${item.id}`}
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          plugin={plugin}
          item={item}
          theme={theme}
        />
      ))}
    </View>
  );
}
const ThemedItems = withUnistyles(Items);
export function PluginAgentHeaderItems(props: AgentHeaderContext) {
  return <ThemedItems {...props} uniProps={themeMapping} />;
}
const styles = StyleSheet.create({
  items: { flexDirection: "row", alignItems: "center", maxWidth: 200, flexShrink: 1 },
});
