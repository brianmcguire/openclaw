import {
  formatAgentEnvelope,
  resolveEnvelopeFormatOptions,
  type AgentEnvelopeParams,
} from "../../auto-reply/envelope.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionUpdatedAtCore } from "../../config/sessions/session-accessor.js";
import { readSessionUpdatedAtInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAgentRoute,
  type ResolvedAgentRoute,
  type ResolveAgentRouteInput,
} from "../../routing/resolve-route.js";

export type ChannelInboundEnvelopeInput = Omit<AgentEnvelopeParams, "previousTimestamp"> & {
  previousTimestamp?: AgentEnvelopeParams["previousTimestamp"] | null;
};

type ChannelInboundEnvelopeBuilderParams = {
  cfg: OpenClawConfig;
  route: Pick<ResolvedAgentRoute, "agentId" | "sessionKey">;
};

/** @deprecated Use createChannelInboundEnvelopeBuilderAsync. Retained until the next Plugin SDK major. */
export function createChannelInboundEnvelopeBuilder(params: ChannelInboundEnvelopeBuilderParams) {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  return createEnvelopeFormatter(params.cfg, () =>
    readSessionUpdatedAtCore({ storePath, sessionKey: params.route.sessionKey }),
  );
}

/** Prepare once per inbound message; history formatting remains synchronous and SQL-free. */
export async function createChannelInboundEnvelopeBuilderAsync(
  params: ChannelInboundEnvelopeBuilderParams,
) {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  const previousTimestamp = await readSessionUpdatedAtInWorker({
    storePath,
    sessionKey: params.route.sessionKey,
  });
  return createEnvelopeFormatter(params.cfg, () => previousTimestamp);
}

function createEnvelopeFormatter(
  cfg: OpenClawConfig,
  readPreviousTimestamp: () => number | undefined,
) {
  const envelope = resolveEnvelopeFormatOptions(cfg);
  return (input: ChannelInboundEnvelopeInput): string => {
    const previousTimestamp =
      input.previousTimestamp === null
        ? undefined
        : (input.previousTimestamp ?? readPreviousTimestamp());
    return formatAgentEnvelope({
      ...input,
      previousTimestamp,
      envelope: input.envelope ?? envelope,
    });
  };
}

/** @deprecated Use resolveAgentRoute and createChannelInboundEnvelopeBuilderAsync. Retained until the next Plugin SDK major. */
export function resolveChannelInboundRouteEnvelope(params: ResolveAgentRouteInput) {
  const route = resolveAgentRoute(params);
  return {
    route,
    buildEnvelope: createChannelInboundEnvelopeBuilder({ cfg: params.cfg, route }),
  };
}
