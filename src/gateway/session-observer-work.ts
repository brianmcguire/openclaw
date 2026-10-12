import type { SessionEntry } from "../config/sessions/types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import type { createSessionObserverCompanionSnapshotReader } from "./session-observer-companion.js";
import type { SessionObserverEvent } from "./session-observer-contract.js";
import type {
  SessionObserverDeps,
  SessionObserverRead,
  SessionObserverState,
} from "./session-observer-model.js";
import { captureSessionObserverRead } from "./session-observer-read.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

export type SessionObserverEventSteps = Generator<
  | { sessionKey: string; agentId: string; reader?: SessionObserverRead }
  | { work: Promise<unknown> },
  void,
  SessionEntry | undefined
>;

/** The observer's accepted work settles independently of scheduler cancellation. */
export function createSessionObserverWork(params: {
  deps: SessionObserverDeps;
  companionReader: ReturnType<typeof createSessionObserverCompanionSnapshotReader>;
  handleEventSteps: (
    event: SessionObserverEvent,
    settledError?: boolean,
    reader?: SessionObserverRead,
  ) => SessionObserverEventSteps;
  canPublish: (state: SessionObserverState, session: SessionEntry | undefined) => boolean;
  beginClose: () => void;
  finishClose: () => void;
  reportError: (error: unknown) => void;
}) {
  let disposed = false;
  let closing = false;
  const acceptedWork = new AsyncWorkScope();
  let eventTail = Promise.resolve();
  const pending = new Set<{ scopeKey: string; current: boolean }>();
  const resetting = new Map<string, object>();
  const reportError = params.reportError;
  const background = (run: () => Promise<unknown>) => {
    void runInDetachedAsyncContext(() => acceptedWork.track(run)).catch(reportError);
  };
  const enqueue = <T>(
    scopeKey: string,
    run: (assertCurrent: () => void, bindScope: (scopeKey: string) => void) => Promise<T>,
  ): Promise<T> => {
    if (closing) {
      return Promise.reject(new Error("Session observer is closed"));
    }
    const operation = { scopeKey, current: true };
    pending.add(operation);
    const assertCurrent = () => {
      if (!operation.current || disposed) {
        throw new Error("Session observer lifecycle changed");
      }
    };
    const result = acceptedWork.track(() =>
      eventTail.then(() =>
        run(assertCurrent, (selectedScope) => {
          operation.scopeKey = selectedScope;
          if (resetting.has(selectedScope)) {
            operation.current = false;
          }
          assertCurrent();
        }),
      ),
    );
    const clearPending = () => {
      pending.delete(operation);
    };
    eventTail = result.then(clearPending, clearPending);
    return result;
  };
  async function handleEventAsync(
    event: SessionObserverEvent,
    settledError = false,
    captured?: SessionObserverRead,
  ) {
    if (closing) {
      throw new Error("Session observer is closed");
    }
    const sessionKey = event.sessionKey ?? "";
    const agentId = event.agentId ?? "";
    const reader =
      captured ??
      (sessionKey && agentId
        ? captureSessionObserverRead(params.deps, sessionKey, agentId)
        : undefined);
    return enqueue(
      resolveSessionSubscriptionKey(sessionKey, agentId),
      async (assertCurrent, bindScope) => {
        assertCurrent();
        const steps = params.handleEventSteps(event, settledError, reader);
        let next = steps.next();
        while (!next.done) {
          if ("work" in next.value) {
            await next.value.work;
            assertCurrent();
            next = steps.next(undefined);
          } else {
            bindScope(resolveSessionSubscriptionKey(next.value.sessionKey, next.value.agentId));
            const source = next.value.reader ?? reader;
            if (!source) {
              throw new Error("Session observer event has no captured source");
            }
            next = await source.withRead((session) => {
              assertCurrent();
              source.assertCurrent();
              return steps.next(session);
            });
          }
        }
      },
    );
  }

  let disposal: Promise<void> | undefined;
  function disposeAsync() {
    if (!disposal) {
      closing = true;
      params.beginClose();
      disposal = eventTail
        .then(() =>
          AsyncWorkScope.runWhenAllIdle(
            () => [acceptedWork],
            () => acceptedWork.drain(),
          ),
        )
        .then(() => {
          if (!disposed) {
            disposed = true;
            params.finishClose();
          }
        });
    }
    return disposal;
  }
  return {
    get closing() {
      return closing;
    },
    get disposed() {
      return disposed;
    },
    resetting,
    background,
    handleEventAsync,
    disposeAsync,
    async withCurrent<T>(
      reader: SessionObserverRead | undefined,
      sessionKey: string,
      agentId: string,
      consume: (session: SessionEntry | undefined) => T,
    ) {
      const source = reader ?? captureSessionObserverRead(params.deps, sessionKey, agentId);
      return source.withRead((session) => {
        source.assertCurrent();
        return consume(session);
      });
    },
    refreshAfterReset(
      sessionKey: string,
      agentId: string,
      consume: (session: SessionEntry | undefined) => void,
    ) {
      const scopeKey = resolveSessionSubscriptionKey(sessionKey, agentId);
      for (const operation of pending) {
        if (operation.scopeKey === scopeKey) {
          operation.current = false;
        }
      }
      if (closing) {
        return;
      }
      const reader = captureSessionObserverRead(params.deps, sessionKey, agentId);
      const reset = {};
      resetting.set(scopeKey, reset);
      void enqueue(scopeKey, async (assertCurrent) => {
        try {
          await reader.withRead((session) => {
            assertCurrent();
            reader.assertCurrent();
            consume(session);
          });
        } finally {
          if (resetting.get(scopeKey) === reset) {
            resetting.delete(scopeKey);
          }
        }
      }).catch(reportError);
    },
    preparePublication(
      this: void,
      state: SessionObserverState,
      publish: () => void,
    ): Promise<void> | undefined {
      const consume = (session: SessionEntry | undefined) => {
        if (params.canPublish(state, session)) {
          publish();
        }
      };
      const reader =
        state.reader ?? captureSessionObserverRead(params.deps, state.sessionKey, state.agentId);
      return acceptedWork.track(() => reader.withRead(consume)).catch(reportError);
    },
    async getCompanionSnapshotAsync(this: void, sessionKey: string, selectedAgentId?: string) {
      if (closing) {
        throw new Error("Session observer is closed");
      }
      const target = params.companionReader.resolve(sessionKey, selectedAgentId);
      const reader = captureSessionObserverRead(
        params.deps,
        target.canonicalSessionKey,
        target.agentId,
      );
      return enqueue(
        resolveSessionSubscriptionKey(target.canonicalSessionKey, target.agentId),
        async (assertCurrent) =>
          reader.withRead((session) => {
            assertCurrent();
            reader.assertCurrent();
            return params.companionReader.read(target, session);
          }),
      );
    },
  };
}
