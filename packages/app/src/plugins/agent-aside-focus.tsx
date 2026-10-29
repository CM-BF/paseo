import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

export interface AgentAsideFocusProps {
  children: ReactNode;
  onFocus(): void;
}

export function AgentAsideFocus({ children, onFocus }: AgentAsideFocusProps) {
  return (
    <View style={styles.container} onTouchStart={onFocus}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ container: { flex: 1, minWidth: 0, minHeight: 0 } });
