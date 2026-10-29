import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";

const PLUGIN_ID = "agent-aside-browser-e2e";

// Only the plugin-owned chrome is synthetic. Conversation is the real host-native panel.
const SOURCE = `import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";

function Topic({ Conversation, close, theme, agentId, parentAgentId, visible, focused }) {
  const [expanded, setExpanded] = useState(false);
  const color = { color: theme.colors.foreground };
  const root = <View testID="aside-root-preview" style={{ padding: 16, gap: 8 }}>
    <Text style={color}>Original message — independent topic background</Text>
    <Text style={color}>{expanded
      ? Array.from({ length: 60 }, (_, index) => "Root background paragraph " + index + ": this belongs to the child transcript scroller, never its parent.\\n").join("\\n")
      : "Short source excerpt. This fixture is not a Cindy profile or a real model."}</Text>
  </View>;
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
    <View style={{ padding: 12, gap: 8 }}>
      <Text style={color}>Topic browser fixture</Text>
      <Text testID="aside-focus" style={color}>{focused ? "Child focused" : "Parent focused"}</Text>
      <Text testID="aside-visible" style={color}>{visible ? "Child visible" : "Child hidden"}</Text>
      <Text testID="aside-identities" style={color}>{parentAgentId + " → " + agentId}</Text>
      <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)}>
        <Text style={color}>{expanded ? "Collapse root background" : "Expand root background"}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={close}><Text style={color}>Close test topic</Text></Pressable>
    </View>
    <Conversation streamHeader={root} />
  </View>;
}

export default function contribute(client) {
  function OpenTopic({ agentId, theme }) {
    const [error, setError] = useState("");
    if (agentId !== PARENT_ID) return null;
    async function open() {
      try { await client.openAgentAside({ id: "topic", parentAgentId: PARENT_ID, agentId: CHILD_ID }); }
      catch (cause) { setError(String(cause)); }
    }
    return <View>
      <Pressable accessibilityRole="button" onPress={open}>
        <Text style={{ color: theme.colors.foreground }}>Open test topic</Text>
      </Pressable>
      {error ? <Text>{error}</Text> : null}
    </View>;
  }
  const removeAside = client.addAgentAside({ id: "topic", Component: Topic });
  const removeHeader = client.addAgentHeaderItem({ id: "open-topic", Component: OpenTopic });
  return () => { removeHeader(); removeAside(); };
}`;

export async function installAgentAsideFixture(parentId: string, childId: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-aside-browser-plugin-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const cleanup = async () => {
    await client.removePlugin(PLUGIN_ID);
    await client.patchDaemonConfig({
      pluginsEnabled: previous.config.pluginsEnabled ?? false,
    });
    await client.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `const PARENT_ID = ${JSON.stringify(
        parentId,
      )};\nconst CHILD_ID = ${JSON.stringify(childId)};\n${SOURCE}`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    return { cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
