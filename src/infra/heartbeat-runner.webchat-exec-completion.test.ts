import { afterEach, expect, it, vi } from "vitest";
import { extractMessagingToolSourceReplyPayload } from "../agents/embedded-agent-messaging-extraction.js";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import { createMessageTool } from "../agents/tools/message-tool-execution.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import type { HeartbeatDeps } from "./heartbeat-runner.js";
import {
  readSessionStoreForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import * as heartbeatTargets from "./outbound/targets.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

it("suppresses a routeless cron reminder on a WebChat session", async () => {
  await withProjectionScenario(async (scenario) => {
    scenario.cfg.messages = undefined;
    enqueueSystemEvent("Reminder: Check the overnight report", {
      sessionKey: scenario.sessionKey,
      contextKey: "cron:overnight-report",
    });
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValue({ text: "Reminder handled" });
    await runProjectionWake(scenario, reply, "cron");
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[0].Body).not.toContain("Please relay this reminder to the user");
    expect(await readProjectionMessages(scenario)).toEqual([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
  resetHeartbeatEventsForTest();
});

type ProjectionScenario = {
  cfg: OpenClawConfig;
  storePath: string;
  sessionKey: string;
  sessionId: string;
};

// Exercise the real dispatcher and SQLite owners; inject only model output.
async function withProjectionScenario(
  run: (scenario: ProjectionScenario) => Promise<void>,
  options: { sessionKey?: string; entry?: Parameters<typeof seedSessionStore>[2] } = {},
) {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "last" } } },
      messages: { visibleReplies: "message_tool" },
      session: { store: storePath },
    };
    const sessionKey = options.sessionKey ?? resolveMainSessionKey(cfg);
    const sessionId = "publication-boundary-session";
    await seedSessionStore(storePath, sessionKey, {
      lastChannel: "webchat",
      lastProvider: "",
      lastTo: "",
      sessionId,
      lifecycleRevision: "publication-boundary-generation",
      createdVia: "operator",
      ...options.entry,
    });
    await run({ cfg, storePath, sessionKey, sessionId });
  });
}

function completionPayload(notificationText: string) {
  return createHeartbeatToolResponsePayload({
    outcome: "done",
    notify: true,
    summary: "private",
    notificationText,
  });
}

// The explicit target keeps hidden and replacement scenarios on their own queue.
function runProjectionWake(
  scenario: ProjectionScenario,
  getReplyFromConfig: HeartbeatDeps["getReplyFromConfig"],
  wake: "exec-event" | "manual" | "cron" = "exec-event",
) {
  return runHeartbeatOnce({
    cfg: scenario.cfg,
    agentId: "main",
    sessionKey: scenario.sessionKey,
    source: wake,
    intent: wake === "manual" ? "immediate" : "event",
    reason: wake === "manual" ? "wake" : wake,
    deps: { getReplyFromConfig },
  });
}

// Read committed assistant output, not payload metadata or a reported send status.
async function readProjectionMessages(scenario: ProjectionScenario) {
  const events = await loadTranscriptEvents({ agentId: "main", ...scenario });
  return events.map(readTranscriptEventMessage).filter((message) => message?.role === "assistant");
}

it("keeps an encoded external destination subject to explicit targeting", async () => {
  await withProjectionScenario(
    async (scenario) => {
      enqueueSystemEvent("Exec completed (encoded-route-proof, code 0) :: PRIVATE_OUTPUT", {
        sessionKey: scenario.sessionKey,
      });
      const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>().mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: false,
          summary: "private",
        }),
      );
      const result = await runProjectionWake(scenario, reply);
      expect(result.status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0]?.[1]).toMatchObject({ requireExplicitMessageTarget: true });
      expect(reply.mock.calls[0]?.[0].OriginatingChannel).toBeUndefined();
    },
    { sessionKey: "agent:main:telegram:direct:123456" },
  );
});

it("keeps an isolated WebChat completion subject to explicit targeting", async () => {
  await withProjectionScenario(async (scenario) => {
    scenario.cfg.agents!.defaults!.heartbeat!.isolatedSession = true;
    const isolatedKey = `${scenario.sessionKey}:heartbeat`;
    await seedSessionStore(scenario.storePath, isolatedKey, {
      sessionId: "isolated-source-policy",
      heartbeatIsolatedBaseSessionKey: scenario.sessionKey,
    });
    enqueueSystemEvent("Exec completed (isolated-proof, code 0) :: PRIVATE_OUTPUT", {
      sessionKey: isolatedKey,
    });
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValue(
        createHeartbeatToolResponsePayload({ outcome: "done", notify: false, summary: "private" }),
      );
    const result = await runProjectionWake({ ...scenario, sessionKey: isolatedKey }, reply);
    expect(result.status).toBe("ran");
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[1]).toMatchObject({ requireExplicitMessageTarget: true });
    expect(reply.mock.calls[0]?.[0].OriginatingChannel).toBeUndefined();
  });
});

it("preserves explicit target:none before target:last delivers in the same WebChat session", async () => {
  await withProjectionScenario(async (scenario) => {
    const heartbeat = scenario.cfg.agents?.defaults?.heartbeat;
    if (!heartbeat) {
      throw new Error("projection scenario heartbeat is missing");
    }
    for (const target of ["none", "last"] as const) {
      heartbeat.target = target;
      const marker = `EXPLICIT_TARGET_${target}`;
      enqueueSystemEvent(`Exec completed (target-proof, code 0) :: ${marker}`, {
        sessionKey: scenario.sessionKey,
      });
      const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>().mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "private",
          notificationText: marker,
        }),
      );
      await runProjectionWake(scenario, reply);
      expect(reply).toHaveBeenCalledOnce();
      const context = reply.mock.calls[0]?.[0];
      const messages = await readProjectionMessages(scenario);
      expect(reply.mock.calls[0]?.[1]).toMatchObject({
        requireExplicitMessageTarget: target === "none",
      });
      if (target === "none") {
        expect(messages).toEqual([]);
        expect(context?.Body).toContain("user delivery is disabled");
      } else {
        expect(messages).toHaveLength(1);
        expect(JSON.stringify(messages[0]?.content)).toContain(marker);
        expect(context?.Body).toContain(marker);
        expect(context?.Body).not.toContain("user delivery is disabled");
      }
    }
  });
});

it.each(["automatic", "message_tool"] as const)(
  "settles an unneeded completion silently in %s mode",
  async (visibleReplies) => {
    await withProjectionScenario(async (scenario) => {
      scenario.cfg.messages = { visibleReplies };
      enqueueSystemEvent("Exec completed (already-handled, code 0) :: Previously reported output", {
        sessionKey: scenario.sessionKey,
      });
      const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>().mockResolvedValue(
        visibleReplies === "automatic"
          ? { text: "NO_REPLY" }
          : createHeartbeatToolResponsePayload({
              outcome: "done",
              notify: false,
              summary: "Result already handled; no new user-facing information.",
            }),
      );

      // The runner must offer silence and retire the event without publishing a recap.
      expect((await runProjectionWake(scenario, reply)).status).toBe("ran");
      const prompt = reply.mock.calls[0]?.[0].Body;
      expect(prompt).toContain("duplicate or superseded results");
      expect(prompt).toContain(
        visibleReplies === "automatic" ? "reply NO_REPLY only" : "notify=false",
      );
      expect(await readProjectionMessages(scenario)).toEqual([]);
      expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
      expect(getLastHeartbeatEvent()?.silent).toBe(true);

      expect((await runProjectionWake(scenario, reply)).status).toBe("skipped");
      expect(reply).toHaveBeenCalledOnce();
      expect(await readProjectionMessages(scenario)).toEqual([]);
    });
  },
);

it.each([
  { target: "last", publishes: true, label: "routeless target:last" },
  { target: "none", publishes: false, label: "explicit target:none" },
  { target: "pagerduty", publishes: false, label: "explicit target with no resolvable route" },
])("$label leaves the completion published: $publishes", async ({ target, publishes }) => {
  await withProjectionScenario(async (scenario) => {
    const heartbeat = scenario.cfg.agents?.defaults?.heartbeat;
    if (!heartbeat) {
      throw new Error("projection scenario heartbeat is missing");
    }
    heartbeat.target = target;
    const marker = `RESOLVER_TARGET_${target.toUpperCase()}`;
    enqueueSystemEvent(`Exec completed (resolver-proof, code 0) :: ${marker}`, {
      sessionKey: scenario.sessionKey,
    });
    const broadcastMessages: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      if (update.sessionKey === scenario.sessionKey && update.message !== undefined) {
        broadcastMessages.push(update.message);
      }
    });
    try {
      const reply = vi
        .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
        .mockResolvedValue(completionPayload(marker));
      const result = await runProjectionWake(scenario, reply);

      // The model runs and the completion is consumed in every arm; only the
      // user-visible publication differs.
      expect(result.status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);

      const messages = await readProjectionMessages(scenario);
      const event = getLastHeartbeatEvent();
      expect(messages).toHaveLength(publishes ? 1 : 0);
      expect(broadcastMessages).toHaveLength(publishes ? 1 : 0);
      if (publishes) {
        const prompt = reply.mock.calls[0]?.[0].Body;
        expect(prompt).toContain("requested result not yet delivered");
        expect(prompt).toContain("duplicate or superseded results");
        expect(prompt).not.toContain("user delivery is disabled");
        expect(JSON.stringify(messages[0]?.content)).toContain(marker);
        expect(event?.status).toBe("sent");
        expect(event?.reason).toBeUndefined();
      } else {
        expect(reply.mock.calls[0]?.[0].Body).toContain("user delivery is disabled");
        expect(event?.status).toBe("skipped");
        expect(event?.reason).toBe("target-none");
      }
    } finally {
      unsubscribe();
    }
  });
});

it.each([
  {
    name: "queued exec completion inspected by a manual wake",
    wake: "manual" as const,
  },
  {
    name: "queued exec completion inspected by a cron wake",
    wake: "cron" as const,
  },
  {
    name: "unopened spawned dashboard",
    sessionKey: "agent:main:dashboard:spawned-completion",
    entry: { createdVia: "spawn" as const },
  },
  {
    name: "previously opened internal conversation",
    entry: { createdVia: "run" as const, lastReadAt: 1 },
  },
])("publishes completion once in $name", async (options) => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (visible-proof, code 0) :: VISIBLE_COMPLETION", {
      sessionKey: scenario.sessionKey,
    });
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValue(completionPayload("VISIBLE_COMPLETION"));
    await runProjectionWake(scenario, reply, "wake" in options ? options.wake : undefined);
    expect(await readProjectionMessages(scenario)).toHaveLength(1);
    expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
    expect(getLastHeartbeatEvent()?.status).toBe("sent");
    await runProjectionWake(scenario, reply);
    expect(reply).toHaveBeenCalledOnce();
    expect(await readProjectionMessages(scenario)).toHaveLength(1);
  }, options);
});

it.each([
  { name: "unstamped internal row", entry: { createdVia: undefined } },
  {
    name: "hidden internal row even with prior readership",
    entry: { createdVia: "internal" as const, lastReadAt: 1 },
  },
  {
    name: "unopened hidden spawned child",
    sessionKey: "agent:main:subagent:hidden-completion",
    entry: { createdVia: "spawn" as const },
  },
  {
    name: "hidden internal-effects key even with operator provenance",
    sessionKey: resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "hidden-proof" })
      .sessionKey,
    entry: { createdVia: "operator" as const },
  },
])("does not publish model output into $name", async (options) => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (hidden-proof, code 0) :: PRIVATE_OUTPUT", {
      sessionKey: scenario.sessionKey,
    });
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValue(completionPayload("PRIVATE_OUTPUT"));
    await runProjectionWake(scenario, reply);
    expect(await readProjectionMessages(scenario)).toEqual([]);
    expect(getLastHeartbeatEvent()?.status).not.toBe("sent");
    if (options.entry.createdVia === "internal") {
      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0]?.[0].Body).not.toContain("requested result not yet delivered");
      expect(reply.mock.calls[0]?.[0].Body).toContain("user delivery is disabled");
    }
  }, options);
});

it.each([
  { field: "unchanged", phase: "routing" },
  { field: "sessionId", phase: "routing" },
  { field: "lifecycleRevision", phase: "routing" },
  { field: "sessionId", phase: "tool" },
  { field: "lifecycleRevision", phase: "tool" },
] as const)(
  "fences a targetless source send ($field replacement at $phase)",
  async ({ field, phase }) => {
    await withProjectionScenario(async (scenario) => {
      const marker = "STALE_TOOL_COMPLETION";
      enqueueSystemEvent(`Exec completed (source-race, code 0) :: ${marker}`, {
        sessionKey: scenario.sessionKey,
      });
      const replaceSource = async () => {
        if (field === "unchanged") {
          return;
        }
        const current = readSessionStoreForTest(scenario.storePath)[scenario.sessionKey];
        await replaceSessionEntry(
          { agentId: "main", storePath: scenario.storePath, sessionKey: scenario.sessionKey },
          {
            ...current,
            sessionId: scenario.sessionId,
            updatedAt: Date.now(),
            [field]: "replacement-generation",
          },
        );
      };
      const resolveTarget = heartbeatTargets.resolveHeartbeatDeliveryTargetWithSessionRoute;
      vi.spyOn(
        heartbeatTargets,
        "resolveHeartbeatDeliveryTargetWithSessionRoute",
      ).mockImplementationOnce(async (params) => {
        const delivery = await resolveTarget(params);
        // Reset can keep the session ID while rotating the admitted lifecycle.
        if (phase === "routing") {
          await replaceSource();
        }
        return delivery;
      });
      let sent = false;
      const reply = vi
        .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
        .mockImplementation(async (_ctx, options) => {
          if (phase === "tool") {
            await replaceSource();
          }
          const current = readSessionStoreForTest(scenario.storePath)[scenario.sessionKey]!;
          // Model boundary: reply initialization selected B. Exercise the real
          // targetless tool and canonical sink, not a pre-persisted fake receipt.
          const message = createMessageTool({
            config: scenario.cfg,
            agentId: "main",
            agentSessionKey: scenario.sessionKey,
            sessionId: current.sessionId,
            runId: "source-race-run",
            currentChannelProvider: "webchat",
            sourceReplyDeliveryMode: "message_tool_only",
            requireExplicitTarget: (options as InternalGetReplyOptions)
              .requireExplicitMessageTarget,
            preparedMessageToolCatalog: {
              version: 0,
              channels: [],
              getChannel: () => undefined,
            },
            getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
            resolveCommandSecretRefsViaGateway: async ({ config }) => ({
              resolvedConfig: config,
              diagnostics: [],
              targetStatesByPath: {},
              hadUnresolvedTargets: false,
            }),
          });
          const result = await message.execute("source-race-send", {
            action: "send",
            message: marker,
          });
          sent = true;
          return buildEmbeddedRunPayloads({
            assistantTexts: [],
            lastAssistant: undefined,
            sessionKey: scenario.sessionKey,
            agentId: "main",
            sourceReplyDeliveryMode: "message_tool_only",
            messagingToolSourceReplyPayloads: [extractMessagingToolSourceReplyPayload(result)!],
          });
        });
      await runProjectionWake(scenario, reply);
      const targetSessionId = field === "sessionId" ? "replacement-generation" : scenario.sessionId;
      const messages = await readProjectionMessages({ ...scenario, sessionId: targetSessionId });
      // The tool receipt owns the single row; heartbeat publication must reuse it.
      const sourceMessages = messages.filter(
        (message) => message !== undefined && JSON.stringify(message.content).includes(marker),
      );
      expect(sourceMessages, JSON.stringify(getLastHeartbeatEvent())).toHaveLength(
        field === "unchanged" ? 1 : 0,
      );
      expect(sent).toBe(field === "unchanged");
    });
  },
);

it.each(["sessionId", "lifecycleRevision"] as const)(
  "rejects output after a %s replacement",
  async (field) => {
    await withProjectionScenario(async (scenario) => {
      enqueueSystemEvent("Exec completed (reset-proof, code 0) :: OLD_GENERATION", {
        sessionKey: scenario.sessionKey,
      });
      const pending = peekSystemEventEntries(scenario.sessionKey);
      const reply = vi
        .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
        .mockImplementation(async () => {
          const current = readSessionStoreForTest(scenario.storePath)[scenario.sessionKey];
          await replaceSessionEntry(
            { storePath: scenario.storePath, sessionKey: scenario.sessionKey },
            {
              ...current,
              sessionId: scenario.sessionId,
              updatedAt: Date.now(),
              [field]: "replacement-generation",
            },
          );
          return completionPayload("OLD_GENERATION");
        });
      await runProjectionWake(scenario, reply);
      expect(getLastHeartbeatEvent()?.status).not.toBe("sent");
      expect(peekSystemEventEntries(scenario.sessionKey).map((event) => event.id)).toEqual(
        pending.map((event) => event.id),
      );
      expect(await readProjectionMessages(scenario)).toEqual([]);
      if (field === "sessionId") {
        expect(
          await readProjectionMessages({ ...scenario, sessionId: "replacement-generation" }),
        ).toEqual([]);
      }
    });
  },
);

it("consumes only captured occurrences and publishes distinct same-text completions", async () => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (first-proof, code 0) :: SAME_NOTIFICATION", {
      sessionKey: scenario.sessionKey,
    });
    const first = peekSystemEventEntries(scenario.sessionKey);
    const payload = completionPayload("SAME_NOTIFICATION");
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockImplementationOnce(async () => {
        enqueueSystemEvent("Exec completed (later-proof, code 0) :: SAME_NOTIFICATION", {
          sessionKey: scenario.sessionKey,
        });
        return payload;
      })
      .mockResolvedValue(payload);
    await runProjectionWake(scenario, reply);
    const later = peekSystemEventEntries(scenario.sessionKey);
    expect(later).toHaveLength(1);
    expect(later[0]?.id).not.toBe(first[0]?.id);
    expect(await readProjectionMessages(scenario)).toHaveLength(1);
    await runProjectionWake(scenario, reply);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
    expect(await readProjectionMessages(scenario)).toHaveLength(2);
  });
});

it("retains the completion occurrence after a failed model turn", async () => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (failed-turn-proof, code 0) :: RETAIN_EVENT", {
      sessionKey: scenario.sessionKey,
    });
    const pending = peekSystemEventEntries(scenario.sessionKey);
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockRejectedValue(new Error("injected model failure"));
    const result = await runProjectionWake(scenario, reply);
    expect(result.status).toBe("failed");
    expect(peekSystemEventEntries(scenario.sessionKey).map((event) => event.id)).toEqual(
      pending.map((event) => event.id),
    );
    expect(await readProjectionMessages(scenario)).toEqual([]);
  });
});

it.each([undefined, "[{model}]"])(
  "reconciles an ordinary persisted final with response prefix %s",
  async (responsePrefix) => {
    await withProjectionScenario(
      async (scenario) => {
        scenario.cfg.messages = { ...scenario.cfg.messages, responsePrefix };
        const text = "ORDINARY_COMPLETION_SOURCE";
        enqueueSystemEvent(`Exec completed (ordinary-proof, code 0) :: ${text}`, {
          sessionKey: scenario.sessionKey,
        });
        const original = {
          role: "assistant",
          content: [{ type: "text", text }],
          idempotencyKey: "ordinary-prefixed-final",
          __openclaw: { runId: "ordinary-writer" },
        };
        const reply = vi
          .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
          .mockImplementation(async () => {
            await persistSessionTranscriptTurn(
              { agentId: "main", ...scenario },
              {
                expectedSessionId: scenario.sessionId,
                expectedLifecycleRevision: "publication-boundary-generation",
                expectedWriterRunId: "ordinary-writer",
                messages: [{ message: original }],
                updateMode: "none",
              },
            );
            return setReplyPayloadMetadata(
              { text },
              {
                assistantTranscriptOwned: true,
                assistantTranscriptIdempotencyKey: original.idempotencyKey,
              },
            );
          });
        await runProjectionWake(scenario, reply);
        expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
        expect(getLastHeartbeatEvent()?.status).toBe("sent");
        expect(await readProjectionMessages(scenario)).toEqual([original]);
        const sentText = readSessionStoreForTest(scenario.storePath)[scenario.sessionKey]
          ?.lastHeartbeatText;
        expect(sentText).toContain(text);
        if (responsePrefix) {
          expect(sentText).toMatch(/^\[/);
        }
        await runProjectionWake(scenario, reply);
        expect(reply).toHaveBeenCalledOnce();
        expect(await readProjectionMessages(scenario)).toEqual([original]);
      },
      { entry: { activeWriterRunId: "ordinary-writer" } },
    );
  },
);

it("does not let a visible failed turn block the successful completion retry", async () => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (retry-proof, code 0) :: RECOVERED_COMPLETION", {
      sessionKey: scenario.sessionKey,
    });
    const pending = peekSystemEventEntries(scenario.sessionKey);
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValueOnce(
        setReplyPayloadMetadata(
          { text: "The notification attempt failed.", isError: true },
          { heartbeatTerminalToolFailure: { toolName: "message" } },
        ),
      )
      .mockResolvedValue(completionPayload("RECOVERED_COMPLETION"));
    expect((await runProjectionWake(scenario, reply)).status).toBe("failed");
    expect(peekSystemEventEntries(scenario.sessionKey).map((event) => event.id)).toEqual(
      pending.map((event) => event.id),
    );
    await runProjectionWake(scenario, reply);
    expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
    expect(
      (await readProjectionMessages(scenario)).filter((message) =>
        JSON.stringify(message?.content).includes("RECOVERED_COMPLETION"),
      ),
    ).toHaveLength(1);
    await runProjectionWake(scenario, reply);
    expect(reply).toHaveBeenCalledTimes(2);
  });
});

it("settles an accepted completion before retrying a later queued occurrence", async () => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (first-drain-proof, code 0) :: FIRST_ACCEPTED", {
      sessionKey: scenario.sessionKey,
    });
    const first = peekSystemEventEntries(scenario.sessionKey);
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValueOnce(completionPayload("FIRST_ACCEPTED"))
      .mockResolvedValue(completionPayload("LATER_ACCEPTED"));
    const result = await withOwnedSessionTranscriptWrites(
      {
        sessionKey: scenario.sessionKey,
        sessionFile: scenario.sessionKey,
        sessionTarget: { agentId: "main", ...scenario },
        withTranscriptWrite: async (run) => {
          await run();
          enqueueSystemEvent("Exec completed (later-drain-proof, code 0) :: LATER_ACCEPTED", {
            sessionKey: scenario.sessionKey,
          });
          throw new Error("owned drain failed after accepted publication");
        },
      },
      () => runProjectionWake(scenario, reply),
    );
    expect(result.status).toBe("ran");
    const pending = peekSystemEventEntries(scenario.sessionKey);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).not.toBe(first[0]?.id);
    expect(getLastHeartbeatEvent()?.status).toBe("sent");
    await runProjectionWake(scenario, reply);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
    const messages = await readProjectionMessages(scenario);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message?.content)).toEqual([
      [{ type: "text", text: "FIRST_ACCEPTED" }],
      [{ type: "text", text: "LATER_ACCEPTED" }],
    ]);
    await runProjectionWake(scenario, reply);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(await readProjectionMessages(scenario)).toEqual(messages);
  });
});
