import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createAccountScopedConversationBindingManagerV2,
  resetAccountScopedConversationBindingsForTests,
} from "./account-scoped-conversation-bindings.js";
import { testing as currentConversationBindingTesting } from "./current-conversation-bindings.js";
import { getSessionBindingService } from "./session-binding-service.js";

type TestBindingKind = "subagent" | "acp";

const stateKey = Symbol("openclaw.accountScopedConversationBindingExpiry.test");
const baseCfg = {
  session: { threadBindings: { idleHours: 1, maxAgeHours: 0 } },
} satisfies OpenClawConfig;

function createManager(params: { accountId?: string; cfg?: OpenClawConfig } = {}) {
  return createAccountScopedConversationBindingManagerV2<TestBindingKind>({
    channel: "imessage",
    cfg: params.cfg ?? baseCfg,
    accountId: params.accountId ?? "ttl-owner",
    stateKey,
    toStoredTargetKind: (kind) => (kind === "subagent" ? "subagent" : "acp"),
    toSessionBindingTargetKind: (kind) => (kind === "subagent" ? "subagent" : "session"),
  });
}

describe("account-scoped conversation binding metadata", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-account-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    resetAccountScopedConversationBindingsForTests({ stateKey });
    currentConversationBindingTesting.clearPersistedCurrentConversationBindingsForTests();
  });

  afterEach(async () => {
    resetAccountScopedConversationBindingsForTests({ stateKey });
    currentConversationBindingTesting.clearPersistedCurrentConversationBindingsForTests();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each(["agent", "plugin"] as const)(
    "preserves opaque %s binding metadata through recreation",
    async (ownerKind) => {
      const cfg = {
        ...baseCfg,
        agents: { entries: { alpha: {}, beta: {} } },
      } satisfies OpenClawConfig;
      const manager = createManager({ cfg });
      const metadata = {
        ...(ownerKind === "agent" ? { agentId: "alpha" } : {}),
        label: "durable label",
        boundBy: "operator",
        pluginBindingOwner: "plugin",
        pluginId: "opaque-plugin",
        pluginRoot: "/plugins/opaque-plugin",
        nested: { ownerEpoch: 7, capabilities: ["approve", "resume"] },
      };
      const conversation = {
        channel: "imessage",
        accountId: manager.accountId,
        conversationId: "chat:opaque-metadata",
      };
      const bound = await getSessionBindingService().bind({
        targetSessionKey:
          ownerKind === "agent"
            ? "agent:alpha:acp:opaque-session"
            : "plugin-binding:opaque-plugin:opaque-session",
        targetKind: "session",
        conversation,
        metadata,
      });

      expect(bound.bindingId).toBe("ttl-owner:chat:opaque-metadata");
      expect(bound.metadata).toMatchObject(metadata);
      expect(bound.metadata?.agentId).toBe(ownerKind === "agent" ? "alpha" : undefined);
      expect(
        (await manager.getByConversationIdAsync(conversation.conversationId))?.targetKind,
      ).toBe("acp");
      await expect(
        getSessionBindingService().bind({
          conversation,
          targetSessionKey: bound.targetSessionKey,
          targetKind: bound.targetKind,
        }),
      ).resolves.toMatchObject({ metadata });
      if (ownerKind === "plugin") {
        await expect(
          getSessionBindingService().bind({
            targetSessionKey: "unscoped-core-target",
            targetKind: "session",
            conversation: { ...conversation, conversationId: "chat:requires-owner" },
          }),
        ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
        expect(await manager.getByConversationIdAsync("chat:requires-owner")).toBeUndefined();
      }

      manager.stop();
      closeOpenClawStateDatabaseForTest();
      createManager({ cfg });

      expect(getSessionBindingService().resolveByConversation(conversation)).toMatchObject({
        bindingId: "ttl-owner:chat:opaque-metadata",
        targetKind: "session",
        metadata,
      });
    },
  );

  it.each([false, true])(
    "inherits runtime metadata only when refreshing the same target (replace=%s)",
    async (replace) => {
      const manager = createManager();
      const service = getSessionBindingService();
      const conversation = {
        channel: "imessage",
        accountId: manager.accountId,
        conversationId: "chat:replacement-owner",
      };
      const metadata = {
        pluginBindingOwner: "plugin",
        pluginId: "owner-plugin",
        pluginRoot: "/plugins/owner-plugin",
        agentId: "previous-agent",
        boundBy: "previous-user",
        opaque: { runtimeId: "original" },
      };
      const originalTarget = "plugin-binding:owner-plugin:original";
      await service.bind({
        targetSessionKey: originalTarget,
        targetKind: "session",
        conversation,
        metadata,
      });
      const targetSessionKey = replace ? "agent:main:acp:replacement" : originalTarget;

      await service.bind({
        targetSessionKey,
        targetKind: "session",
        conversation,
        metadata: { label: "updated" },
      });
      manager.stop();
      closeOpenClawStateDatabaseForTest();
      createManager();

      expect(service.resolveByConversation(conversation)).toMatchObject({
        targetSessionKey,
        metadata: {
          agentId: replace ? "main" : "previous-agent",
          label: "updated",
        },
      });
      const resolvedMetadata = service.resolveByConversation(conversation)?.metadata;
      for (const key of [
        "pluginBindingOwner",
        "pluginId",
        "pluginRoot",
        "boundBy",
        "opaque",
      ] as const) {
        expect(resolvedMetadata?.[key]).toEqual(replace ? undefined : metadata[key]);
      }
    },
  );
});
