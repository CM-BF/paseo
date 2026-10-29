import { createContext, useContext, type ReactNode } from "react";
import type { ClientSlashCommand } from "@/client-slash-commands";

interface ConversationPresentation {
  embedded: boolean;
  streamHeader?: ReactNode;
}

const Context = createContext<ConversationPresentation>({ embedded: false });

export const ConversationPresentationProvider = Context.Provider;

export function useConversationPresentation(): ConversationPresentation {
  return useContext(Context);
}

/** Run before the composer clears its draft and again before any native lifecycle mutation. */
export function assertConversationCommandAllowed(
  embedded: boolean,
  command: ClientSlashCommand,
): void {
  if (embedded) {
    throw new Error(
      `/${command.name} is unavailable in this conversation aside. Your draft is preserved. Close the aside to return to the parent conversation.`,
    );
  }
}
