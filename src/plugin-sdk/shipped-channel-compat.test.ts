import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChannelProgressDraftCompositorSnapshot } from "../channels/progress-draft-compositor.types.js";
import {
  DiscordConfigSchema,
  MSTeamsConfigSchema,
  SignalConfigSchema,
  SlackConfigSchema,
} from "./bundled-channel-config-schema.js";
import type {
  ChannelInboundEnvelopeInput,
  createChannelInboundEnvelopeBuilder,
  createChannelInboundEnvelopeBuilderAsync,
  resolveChannelInboundRouteEnvelope,
  resolveInboundSessionEnvelopeContextAsync,
} from "./channel-inbound.js";
import type { inspectConversationBinding } from "./conversation-binding-inspection-runtime.js";
import type { ReplyDispatchRuntimeInfo } from "./reply-runtime.js";
import type { PluginRuntime } from "./runtime-store.js";
import type { SessionBindingRecord, SessionBindingService } from "./session-binding-runtime.js";
import type { readSessionUpdatedAtAsync } from "./session-store-runtime.js";
import {
  createLegacyCompatChannelDmPolicy,
  promptLegacyChannelAllowFromForAccount,
} from "./setup-runtime.js";

describe("shipped external channel compatibility", () => {
  it("retains the synchronous binding selectors shipped in 2026.9.8", () => {
    expectTypeOf<SessionBindingService["listBySession"]>().toEqualTypeOf<
      (targetSessionKey: string) => SessionBindingRecord[]
    >();
    expectTypeOf<
      SessionBindingService["resolveByConversation"]
    >().returns.toEqualTypeOf<SessionBindingRecord | null>();
    expectTypeOf<typeof inspectConversationBinding>().returns.toEqualTypeOf<
      { status: "available"; binding: SessionBindingRecord | null } | { status: "unavailable" }
    >();
  });

  it("retains synchronous envelope results shipped in 2026.9.8", () => {
    expectTypeOf<typeof createChannelInboundEnvelopeBuilder>().returns.toEqualTypeOf<
      (input: ChannelInboundEnvelopeInput) => string
    >();
    expectTypeOf<
      ReturnType<typeof resolveChannelInboundRouteEnvelope>["buildEnvelope"]
    >().toEqualTypeOf<(input: ChannelInboundEnvelopeInput) => string>();
  });

  it("adds awaited timestamp preparation without changing released input shapes", () => {
    type RuntimeSession = PluginRuntime["channel"]["session"];
    expectTypeOf<typeof readSessionUpdatedAtAsync>().returns.toEqualTypeOf<
      Promise<number | undefined>
    >();
    expectTypeOf<RuntimeSession["readSessionUpdatedAtAsync"]>().returns.toEqualTypeOf<
      Promise<number | undefined>
    >();
    expectTypeOf<Parameters<typeof createChannelInboundEnvelopeBuilderAsync>>().toEqualTypeOf<
      Parameters<typeof createChannelInboundEnvelopeBuilder>
    >();
    expectTypeOf<typeof createChannelInboundEnvelopeBuilderAsync>().returns.toEqualTypeOf<
      Promise<(input: ChannelInboundEnvelopeInput) => string>
    >();
    expectTypeOf<typeof resolveInboundSessionEnvelopeContextAsync>().returns.toMatchTypeOf<
      Promise<{ previousTimestamp: number | undefined }>
    >();
  });

  it("retains named config schema exports used by published channel packages", () => {
    for (const schema of [
      SlackConfigSchema,
      DiscordConfigSchema,
      SignalConfigSchema,
      MSTeamsConfigSchema,
    ]) {
      expect(schema.safeParse({ legacySetting: true })).toMatchObject({ success: true });
      expect(schema.toJSONSchema({ target: "draft-07" })).toMatchObject({ type: "object" });
    }
  });

  it("retains setup helpers used by published Slack and Discord packages", () => {
    expect(createLegacyCompatChannelDmPolicy).toBeTypeOf("function");
    expect(promptLegacyChannelAllowFromForAccount).toBeTypeOf("function");
  });

  it("keeps the 2026.9.8 receipt progress handoff source-compatible", () => {
    type ReleasedReceipt = {
      channel: string;
      accountId?: string;
      to: string;
      threadId?: string | number;
      messageId: string;
      text: string;
      snapshot: ChannelProgressDraftCompositorSnapshot;
    };
    expectTypeOf<ReplyDispatchRuntimeInfo["adoptProgressContinuation"]>().toEqualTypeOf<
      ((this: void, receipt: ReleasedReceipt) => Promise<boolean>) | undefined
    >();
  });
});
