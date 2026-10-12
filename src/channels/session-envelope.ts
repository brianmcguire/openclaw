// Session-envelope context resolver for inbound channel turns.
import { resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { readSessionUpdatedAtInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Prepares descriptive session facts before building an inbound envelope. */
export async function resolveInboundSessionEnvelopeContextAsync(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}) {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(params.cfg);
  const previousTimestamp = await readSessionUpdatedAtInWorker({
    storePath,
    sessionKey: params.sessionKey,
  });
  return { storePath, envelopeOptions, previousTimestamp };
}
