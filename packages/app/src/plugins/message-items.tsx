import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type { PluginMessageContribution, PluginMessageProps } from "@getpaseo/plugin/client";
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
import { messageReferenceKey } from "./message-identity";

interface MessageContext {
  serverId: string;
  message: PluginMessageProps["message"];
  slot: "action" | "footer";
  agentId: string;
}
const noError = () => null;
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function Item({
  plugin,
  item,
  message,
  agentId,
  theme,
}: Omit<MessageContext, "slot"> & {
  plugin: InstalledPlugin;
  item: PluginMessageContribution;
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
  const props: PluginMessageProps = {
    theme,
    host,
    layout,
    navigation,
    message,
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
  message,
  agentId,
  theme,
  slot,
}: MessageContext & { theme: PluginTheme }) {
  const plugins = useInstalledPlugins();
  const client = useHostRuntimeClient(serverId);
  if (!client) return null;
  const items = plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) =>
      (slot === "action" ? plugin.messageActions : plugin.messageFooters).map((item) => ({
        plugin,
        item,
      })),
    );
  if (!items.length) return null;
  return (
    <View style={slot === "action" ? styles.actions : styles.footers}>
      {items.map(({ plugin, item }) => (
        <Item
          key={`${serverId}:${agentId}:${messageReferenceKey(message.reference)}:${plugin.id}:${item.id}`}
          serverId={serverId}
          message={message}
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
export function PluginMessageItems(props: MessageContext) {
  return <ThemedItems {...props} uniProps={themeMapping} />;
}
const styles = StyleSheet.create({
  actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 },
  footers: { flexDirection: "column" },
});

/** Memoized elements keep the native message's memo boundary intact. */
export function usePluginMessageAdornments(
  serverId: string | undefined,
  agentId: string | undefined,
  message: PluginMessageProps["message"] | undefined,
) {
  return useMemo(() => {
    if (!serverId || !agentId || !message) return { actions: null, footer: null };
    return {
      actions: (
        <PluginMessageItems serverId={serverId} agentId={agentId} message={message} slot="action" />
      ),
      footer: (
        <PluginMessageItems serverId={serverId} agentId={agentId} message={message} slot="footer" />
      ),
    };
  }, [serverId, agentId, message]);
}
