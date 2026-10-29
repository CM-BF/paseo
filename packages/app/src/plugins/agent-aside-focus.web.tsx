import type { AgentAsideFocusProps } from "./agent-aside-focus";

export function AgentAsideFocus({ children, onFocus }: AgentAsideFocusProps) {
  return (
    <div style={containerStyle} onPointerDownCapture={onFocus} onFocusCapture={onFocus}>
      {children}
    </div>
  );
}

const containerStyle = { display: "flex", flex: 1, minWidth: 0, minHeight: 0 };
