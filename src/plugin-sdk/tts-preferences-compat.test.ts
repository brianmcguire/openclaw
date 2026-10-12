import { expectTypeOf, it } from "vitest";
import type { OpenClawConfig } from "./config-contracts.js";
import type { ReplyPayload } from "./reply-payload.js";
import type { buildTtsSystemPromptHint, maybeApplyTtsToPayload } from "./tts-runtime.js";

it("retains the TTS call signatures from the released Plugin SDK", () => {
  expectTypeOf<typeof buildTtsSystemPromptHint>().toExtend<
    (
      cfg: OpenClawConfig,
      agentId?: string,
      options?: { messageToolOnly?: boolean },
    ) => string | undefined
  >();
  expectTypeOf<typeof maybeApplyTtsToPayload>().toExtend<
    (params: {
      payload: ReplyPayload;
      cfg: OpenClawConfig;
      channel?: string;
      kind?: "tool" | "block" | "final";
      inboundAudio?: boolean;
      ttsAuto?: string;
      agentId?: string;
      accountId?: string;
    }) => Promise<ReplyPayload>
  >();
});
