import type { InternalGetReplyOptions } from "./get-reply.types.js";

export type PluginBindingTranscriptOwner = {
  agentId: string;
  expectedSessionId?: string;
  sessionKey: string;
  transcriptWriteBlocked?: true;
};

export function admittedSessionSettingsRestrictRuntime(
  settings: InternalGetReplyOptions["admittedSessionSettings"],
): boolean {
  return (
    (settings?.permissionMode !== undefined && settings.permissionMode !== "full") ||
    (settings?.toolOverrides !== undefined && Object.keys(settings.toolOverrides).length > 0)
  );
}
