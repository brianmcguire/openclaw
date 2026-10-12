import assert from "node:assert/strict";
import { expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withTranscriptWriteLock } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionTranscriptWriteLockAccessorContext } from "../config/sessions/session-accessor.types.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

async function seed(env: NodeJS.ProcessEnv) {
  const scope = { agentId: "main", sessionId: "locked", sessionKey: "agent:main:locked", env };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  return { ...scope, storePath: openOpenClawAgentDatabase(scope).path };
}

it("drains accepted operations after callback failure and seals the native context", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = await seed(env);
    const entered = createDeferred();
    const release = createDeferred();
    const preparationFailure = new Error("Preparation failed");
    const callbackFailure = new Error("Callback failed");
    let retained: SessionTranscriptWriteLockAccessorContext | undefined;
    const accepted: Promise<unknown>[] = [];
    const writing = withTranscriptWriteLock(scope, (locked) => {
      retained = locked;
      accepted.push(
        locked.appendMessage({
          message: { role: "assistant", content: "rejected" },
          prepareMessageAfterIdempotencyCheckAsync: async () => {
            entered.resolve();
            await release.promise;
            throw preparationFailure;
          },
        }),
      );
      accepted.push(
        locked.appendMessageWithMessageSequence({
          eventId: "accepted",
          message: { role: "assistant", content: "settled" },
        }),
      );
      accepted.push(locked.readEvents());
      throw callbackFailure;
    });
    const outcome = writing.catch((error: unknown) => error);
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, outcome, "Append was not retained"),
        signal,
      );
      assert(retained);
      await expect(retained.replaceEvents([])).rejects.toThrow("context is closed");
      release.resolve();
      const failure = await withinTest(outcome, signal);
      expect(failure).toBe(callbackFailure);
      await expect(accepted[0]).rejects.toBe(preparationFailure);
      await expect(accepted[1]).resolves.toMatchObject({ result: { messageId: "accepted" } });
      await expect(accepted[2]).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "accepted" })]),
      );
      await expect(
        withTranscriptWriteLock(scope, async (locked) => {
          await expect(
            locked.appendMessage({
              message: { role: "assistant", content: "handled refusal" },
              prepareMessageAfterIdempotencyCheckAsync: async () => {
                throw preparationFailure;
              },
            }),
          ).rejects.toBe(preparationFailure);
          return "recovered";
        }),
      ).resolves.toBe("recovered");
    } finally {
      release.resolve();
      await Promise.allSettled([writing, ...accepted]);
    }
  });
});
