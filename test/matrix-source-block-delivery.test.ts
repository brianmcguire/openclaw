// The core owns this composition: plugins may not import private dispatch internals.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createWireRecorder } from "openclaw/plugin-sdk/channel-contract-testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
  createRecordingMatrixClient,
  installMatrixDeliveryTraceRuntime,
} from "../extensions/matrix/delivery.test-api.js";
import { EmbeddedBlockChunker } from "../src/agents/embedded-agent-block-chunker.js";
import { setReplyPayloadMetadata } from "../src/auto-reply/reply-payload.js";
import { createBlockReplyPipeline } from "../src/auto-reply/reply/block-reply-pipeline.js";
import * as dispatchHarness from "../src/auto-reply/reply/dispatch-from-config.test-support.js";
import { isFinalizedInboundContext } from "../src/auto-reply/reply/inbound-context.js";
import { createReplyDispatcherWithTyping } from "../src/auto-reply/reply/reply-dispatcher.js";
import { toCoreManagedDeliveryInfo } from "../src/channels/turn/direct-delivery-custody.js";

// mock-isolation: This fixture has no durable binding; delivery still settles through core.
vi.mock("openclaw/plugin-sdk/conversation-binding-inspection-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("openclaw/plugin-sdk/conversation-binding-inspection-runtime")
  >()),
  inspectConversationBindingAsync: async () => ({ status: "available", binding: null }),
}));
const ROOM_ID = "!room:example.org";
beforeAll(installMatrixDeliveryTraceRuntime);

describe("Matrix source block delivery through settled core dispatch", () => {
  beforeAll(dispatchHarness.globalBeforeAll0);
  beforeEach(() => {
    dispatchHarness.describe0BeforeEach0();
    dispatchHarness.setNoAbort();
  });

  it("does not send and redact a trailing draft after delivering paragraphs", async () => {
    const recorder = createWireRecorder();
    const paragraphs = [
      "First paragraph describes the completed build.",
      "Second paragraph describes the successful deployment.",
      "Third paragraph describes the healthy service.",
    ];
    let settledDispatcher:
      | ReturnType<typeof createReplyDispatcherWithTyping>["dispatcher"]
      | undefined;
    const { handler } = createMatrixHandlerTestHarness({
      streaming: "partial",
      blockStreamingEnabled: true,
      client: createRecordingMatrixClient(recorder),
      createReplyDispatcherWithTyping: (options) => {
        if (!options || !("deliver" in options) || typeof options.deliver !== "function") {
          throw new Error("Matrix did not provide its delivery adapter");
        }
        const deliver = options.deliver;
        const prepared = createReplyDispatcherWithTyping({
          ...options,
          deliver: async (payload, info) =>
            await deliver(payload, toCoreManagedDeliveryInfo(info, payload)),
        });
        settledDispatcher = prepared.dispatcher;
        return prepared;
      },
      dispatchInboundMessage: async ({ ctx, cfg, replyOptions }) => {
        if (!settledDispatcher) {
          throw new Error("Matrix dispatcher was not prepared");
        }
        if (!isFinalizedInboundContext(ctx)) {
          throw new Error("Matrix harness must pass its finalized inbound context");
        }
        return await dispatchHarness.dispatchReplyFromConfig({
          ctx,
          cfg,
          dispatcher: settledDispatcher,
          replyOptions,
          replyResolver: async (_ctx, options) => {
            await options?.onReplyStart?.();
            await options?.onAssistantMessageStart?.();
            const chunker = new EmbeddedBlockChunker({
              minChars: 1,
              maxChars: 4096,
              breakPreference: "paragraph",
              flushOnParagraph: true,
            });
            const pipeline = createBlockReplyPipeline({
              onBlockReply: (payload, context) => options?.onBlockReply?.(payload, context),
              timeoutMs: 0,
              coalescing: { minChars: 1, maxChars: 1, idleMs: 0, joiner: "\n" },
            });
            try {
              let fullText = "";
              for (const paragraph of paragraphs) {
                const delta = `${paragraph}\n\n`;
                fullText += delta;
                await options?.onPartialReply?.({ text: fullText });
                chunker.append(delta);
                chunker.drain({
                  force: false,
                  emit: (text, source) => {
                    pipeline.enqueue(
                      setReplyPayloadMetadata(
                        { text },
                        {
                          assistantMessageIndex: 1,
                          blockSourceText: source?.sourceText,
                          blockSourceRange: source
                            ? [source.sourceStart, source.sourceEnd]
                            : undefined,
                        },
                      ),
                    );
                  },
                });
                await pipeline.flush({ force: true });
              }
            } finally {
              pipeline.stop();
            }
            return undefined;
          },
        });
      },
    });

    await handler(
      ROOM_ID,
      createMatrixTextMessageEvent({
        eventId: "$paragraph-proof",
        body: "Summarize the deployment in three paragraphs.",
        originServerTs: Date.now(),
      }),
    );
    const wire = recorder.finish().filter((event) => event.dir === "out");
    const visible = new Map<string, string>();
    const effects: Array<{ kind: string; eventId: string; text?: string }> = [];
    let previewSent = false;
    for (const event of wire) {
      const call = event.data;
      if (!isRecord(call)) {
        continue;
      }
      if (event.kind === "redactEvent" && typeof call.target === "string") {
        visible.delete(call.target);
        effects.push({ kind: "redact", eventId: call.target });
      }
      if (event.kind !== "sendMessage" || !isRecord(call.payload) || !isRecord(call.result)) {
        continue;
      }
      const content = call.payload;
      const relation = content["m.relates_to"];
      const replacement = content["m.new_content"];
      if (isRecord(relation) && typeof relation.event_id === "string" && isRecord(replacement)) {
        if (typeof replacement.body === "string") {
          visible.set(relation.event_id, replacement.body);
          effects.push({ kind: "edit", eventId: relation.event_id, text: replacement.body });
        }
      } else if (typeof call.result.event_id === "string" && typeof content.body === "string") {
        visible.set(call.result.event_id, content.body);
        effects.push({ kind: "send", eventId: call.result.event_id, text: content.body });
        previewSent ||= "org.matrix.msc4357.live" in content;
      }
    }
    console.info(`[matrix-source-block-proof] ${JSON.stringify(effects)}`);
    const trace = JSON.stringify(effects, null, 2);
    expect(previewSent, trace).toBe(true);
    expect([...visible.values()], trace).toEqual(paragraphs);
    expect(
      effects.filter((effect) => effect.kind === "redact"),
      trace,
    ).toEqual([]);
  });
});
