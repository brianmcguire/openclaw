import type { TurnAdoptionLifecycle } from "../auto-reply/get-reply-options.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOutboundReplyPayload,
  type OutboundReplyPayload,
} from "../plugin-sdk/reply-payload.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { buildChannelInboundEventContext } from "./inbound-event/context.js";
import { createChannelInboundEnvelopeBuilderAsync } from "./inbound-event/envelope.js";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "./message-access/runtime-types.js";
import { createChannelReplyPipeline } from "./message/reply-pipeline.js";
import { dispatchRoutedChannelTurn } from "./turn/lifecycle.js";
import type { ChannelTurnPlan } from "./turn/types.js";
export type { AccessGroupMembershipResolver } from "../plugin-sdk/access-groups.js";
export {
  createDirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "./direct-dm-guard-policy.js";

type DirectDmRoutePeer = { kind: "direct"; id: string };
type DirectDmRoute = { agentId: string; sessionKey: string; accountId?: string };

type DispatchInboundDirectDmParams = {
  cfg: OpenClawConfig;
  channel: string;
  channelLabel: string;
  accountId: string;
  peer: DirectDmRoutePeer;
  senderId: string;
  senderAddress: string;
  recipientAddress: string;
  conversationLabel: string;
  rawBody: string;
  messageId: string;
  timestamp?: number;
  commandAuthorized?: boolean;
  turnAdoptionLifecycle?: TurnAdoptionLifecycle;
  /** Shipped SDK callers may omit provenance; bundled callers must classify it explicitly. */
  channelIngress?: ResolvedChannelMessageIngress | "unsupported";
  /** Resolve the exact admitted result after this helper owns the final route. */
  resolveChannelIngress?: (
    contextBinding: ChannelIngressContextBinding,
  ) => Promise<ResolvedChannelMessageIngress>;
  /** Opaque record-scoped runtime injected by a registered native channel. */
  channelRuntime?: { inbound?: { buildContext?: unknown } };
  /** Set only after the channel's sender/pairing guard admits this event. */
  inboundAccessAuthorized?: boolean;
  /** Recheck channel-owned live authority after preparation and at effect initiation. */
  assertAuthority?: () => void;
  bodyForAgent?: string;
  commandBody?: string;
  provider?: string;
  surface?: string;
  originatingChannel?: string;
  originatingTo?: string;
  extraContext?: Record<string, unknown>;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
};

async function buildDirectDmContext(
  params: DispatchInboundDirectDmParams,
  route: DirectDmRoute,
  body: string,
): Promise<FinalizedMsgContext> {
  const accountId = route.accountId ?? params.accountId;
  const injectedBuilder = params.channelRuntime?.inbound?.buildContext;
  const buildContext =
    typeof injectedBuilder === "function"
      ? (injectedBuilder as typeof buildChannelInboundEventContext)
      : buildChannelInboundEventContext;
  return buildContext({
    channel: params.channel,
    accountId,
    provider: params.provider,
    surface: params.surface,
    messageId: params.messageId,
    messageIdFull: params.messageId,
    timestamp: params.timestamp,
    from: params.senderAddress,
    sender: { id: params.senderId, name: params.conversationLabel },
    conversation: {
      kind: "direct",
      id: params.peer.id,
      routePeer: params.peer,
      label: params.conversationLabel,
    },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: {
      to: params.recipientAddress,
      originatingTo: params.originatingTo ?? params.senderAddress,
    },
    message: {
      body,
      bodyForAgent: params.bodyForAgent ?? params.rawBody,
      rawBody: params.rawBody,
      commandBody: params.commandBody ?? params.rawBody,
    },
    access: { commands: { authorized: params.commandAuthorized === true } },
    channelIngress: params.channelIngress,
    extra: {
      NativeDirectUserId: params.peer.id,
      OriginatingChannel: params.originatingChannel ?? params.channel,
      ...params.extraContext,
    },
  });
}

export async function dispatchInboundDirectDm(params: DispatchInboundDirectDmParams): Promise<{
  route: DirectDmRoute;
  ctxPayload: FinalizedMsgContext;
}> {
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  const channelIngress = params.resolveChannelIngress
    ? await params.resolveChannelIngress({
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        messageId: params.messageId,
        inboundEventKind: "user_request",
      })
    : params.channelIngress;
  const boundParams =
    channelIngress === params.channelIngress ? params : { ...params, channelIngress };
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({ cfg: params.cfg, route });
  const ctxPayload = await buildDirectDmContext(
    boundParams,
    route,
    buildEnvelope({
      channel: params.channelLabel,
      from: params.conversationLabel,
      body: params.rawBody,
      timestamp: params.timestamp,
    }),
  );
  await dispatchRoutedChannelTurn(buildDirectDmTurnPlan(boundParams, route, ctxPayload));

  return { route, ctxPayload };
}

function buildDirectDmTurnPlan(
  params: DispatchInboundDirectDmParams,
  route: DirectDmRoute,
  ctxPayload: FinalizedMsgContext,
): ChannelTurnPlan {
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: route.agentId,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
  });

  return {
    cfg: params.cfg,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    route: { agentId: route.agentId, sessionKey: route.sessionKey },
    ctxPayload,
    assertAuthority: params.assertAuthority,
    record: {
      onRecordError: params.onRecordError,
    },
    delivery: {
      deliver: async (payload) => await params.deliver(normalizeOutboundReplyPayload(payload)),
      onError: params.onDispatchError,
    },
    replyPipeline,
    replyOptions: {
      onModelSelected,
      ...(params.turnAdoptionLifecycle
        ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
        : {}),
    },
  };
}
