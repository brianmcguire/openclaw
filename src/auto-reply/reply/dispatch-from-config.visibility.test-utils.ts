// Loaded with the dispatch suite so visibility contracts share its mocked module graph.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  hookMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticGroupReplyConfig,
  dispatchReplyFromConfig,
  setNoAbort,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("reply dispatch live visibility contracts", () => {
  beforeEach(describe0BeforeEach0);

  it("reports live verbose progress visibility to the channel", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = { verboseLevel: "on" };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    let isActive: (() => Promise<boolean>) | undefined;
    let activeDuringRun: boolean | undefined;
    let activeAfterLevelChange: boolean | undefined;
    const replyResolver = async () => {
      activeDuringRun = await isActive?.();
      sessionStoreMocks.currentEntry = { verboseLevel: "off" };
      activeAfterLevelChange = await isActive?.();
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        onVerboseProgressVisibilityAsync: (getter: () => Promise<boolean>) => {
          isActive = getter;
        },
      },
    });

    expect(activeDuringRun).toBe(true);
    expect(activeAfterLevelChange).toBe(false);

    sessionStoreMocks.currentEntry = { verboseLevel: "off" };
    let isActiveOff: (() => Promise<boolean>) | undefined;
    let activeDuringOffRun: boolean | undefined;
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: async () => {
        activeDuringOffRun = await isActiveOff?.();
        return { text: "done" } satisfies ReplyPayload;
      },
      replyOptions: {
        onVerboseProgressVisibilityAsync: (getter: () => Promise<boolean>) => {
          isActiveOff = getter;
        },
      },
    });

    expect(activeDuringOffRun).toBe(false);
  });

  it("exposes live group tool-summary state to reply_dispatch hooks", async () => {
    // Group policy needs the loaded fixture's conversation grammar.
    setActivePluginRegistry(createSessionConversationTestRegistry());
    setNoAbort();
    sessionStoreMocks.currentEntry = { verboseLevel: "off" };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "matrix",
      Surface: "matrix",
      ChatType: "group",
      From: "matrix:!room:test",
      SessionKey: "agent:main:matrix:group:!room:test",
    });
    let initialHookState: boolean | undefined;
    let updatedHookState: boolean | undefined;
    hookMocks.runner.runReplyDispatch.mockImplementationOnce(async (event: unknown) => {
      const replyDispatchEvent = event as {
        shouldSendToolSummariesAsync: () => Promise<boolean>;
      };
      initialHookState = await replyDispatchEvent.shouldSendToolSummariesAsync();
      sessionStoreMocks.currentEntry = { verboseLevel: "on" };
      updatedHookState = await replyDispatchEvent.shouldSendToolSummariesAsync();
      return undefined;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(initialHookState).toBe(false);
    expect(updatedHookState).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });
});
