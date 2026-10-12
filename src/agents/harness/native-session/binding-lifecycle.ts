import { AsyncLocalStorage } from "node:async_hooks";
import { resolveRuntimeFacadeModuleLocation } from "../../../plugin-sdk/facade-resolution-shared.js";
import type { PluginStateNativeBindingCodec } from "../../../plugin-state/plugin-state-native-binding.types.js";
import { capturePluginStateNativeBindingStore } from "../../../plugin-state/plugin-state-store.native-binding.js";
import { validateKey } from "../../../plugin-state/plugin-state-store.validation.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { AgentHarnessSessionDeletionMutation } from "../types.js";
import {
  createNativeSessionBindingLeasesV2,
  type NativeSessionBindingLeaseConfig,
  type NativeSessionBindingLeaseOptions,
  type NativeSessionBindingRecord,
  type NativeSessionBindingStateStoreV2,
} from "./binding-leases.js";
import { createNativeSessionBindingNativeSettlement } from "./binding-native-settlement.js";
import {
  bindNativeSessionDeletionParticipant,
  type NativeSessionDeletionParticipant,
} from "./deletion-participant.js";

/** Worker-owned binding coordination with an audited native deletion participant. */
export function createNativeSessionBindingLifecycleV2<TRecord extends NativeSessionBindingRecord>(
  state: NativeSessionBindingStateStoreV2<TRecord>,
  options: NativeSessionBindingLifecycleOptions<TRecord> & {
    workerCodec: PluginStateNativeBindingCodec;
  },
) {
  return createNativeSessionBindingLifecycleOwner(state, options);
}

function createNativeSessionBindingLifecycleOwner<TRecord extends NativeSessionBindingRecord>(
  state: NativeSessionBindingStateStoreV2<TRecord>,
  options: NativeSessionBindingLifecycleOptions<TRecord>,
) {
  const leases = createNativeSessionBindingLeasesV2(state, options);
  const exclusiveContext = new AsyncLocalStorage<boolean>();
  let activeMutations = 0;
  let pendingExclusiveOperations = 0;
  let exclusiveTail = Promise.resolve();
  // The exclusive tail admits only one drain waiter at a time.
  let mutationsDrained: (() => void) | undefined;

  const waitForMutations = async (): Promise<void> => {
    if (activeMutations === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      mutationsDrained = resolve;
    });
  };

  const withMutation = async <TResult>(run: () => Promise<TResult>): Promise<TResult> => {
    if (exclusiveContext.getStore() === true) {
      return await run();
    }
    // Exclusive native operations require one stable ownership snapshot. Late
    // callers cannot attach bindings after that operation has begun.
    if (pendingExclusiveOperations > 0) {
      throw new Error(options.errors.mutationBlocked);
    }
    activeMutations += 1;
    try {
      return await run();
    } finally {
      activeMutations -= 1;
      if (activeMutations === 0) {
        const drained = mutationsDrained;
        mutationsDrained = undefined;
        drained?.();
      }
    }
  };

  const withExclusiveMutationFence = async <TResult>(
    run: () => Promise<TResult>,
  ): Promise<TResult> => {
    pendingExclusiveOperations += 1;
    const operation = exclusiveTail.then(async () => {
      await waitForMutations();
      return await exclusiveContext.run(true, run);
    });
    exclusiveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await operation;
    } finally {
      pendingExclusiveOperations -= 1;
    }
  };

  const withDeletion = async <TResult>(
    key: string,
    deletion: NativeSessionBindingDeletionOptions<TRecord>,
    run: (
      current: TRecord | undefined,
      mutation: AgentHarnessSessionDeletionMutation,
    ) => Promise<TResult>,
  ): Promise<TResult> => {
    leases.assertSettled(key);
    const store = options.workerCodec
      ? capturePluginStateNativeBindingStore(
          state.withCurrent({ assertCurrent: deletion.assertCurrent }),
        )
      : undefined;
    const workerCodec =
      (options.workerCodec === "codex" || options.workerCodec === "agentsapi") &&
      store?.options.pluginId === options.workerCodec
        ? options.workerCodec
        : undefined;
    const workerSource =
      workerCodec && store
        ? captureOpenClawStateWorkerContext({ env: store.options.env })
        : undefined;
    const codecOwner = workerCodec
      ? resolveRuntimeFacadeModuleLocation({
          dirName: workerCodec,
          artifactBasename: "native-session-binding-api.js",
        })
      : undefined;
    if (codecOwner === null) {
      throw new Error(`Native session binding codec is unavailable: ${workerCodec}`);
    }
    const bindParticipant = (
      mutation: AgentHarnessSessionDeletionMutation,
      value?: Omit<TRecord, "lease">,
      owner?: ReturnType<typeof leases.owner>,
    ) => {
      if (
        !store ||
        !workerSource ||
        !workerCodec ||
        !workerSource.admission.identity.key.startsWith("file:")
      ) {
        return mutation;
      }
      const custody = new Set<object>();
      const participant: NativeSessionDeletionParticipant = {
        binding: {
          codec: workerCodec,
          codecSource: codecOwner
            ? {
                rootDir: codecOwner.boundaryRoot,
                source: codecOwner.modulePath,
                origin: codecOwner.origin ?? "global",
              }
            : undefined,
          pluginId: store.options.pluginId,
          namespace: store.options.namespace,
          key: validateKey(key, "delete"),
          maxEntries: store.options.maxEntries,
          overflowPolicy: store.options.overflowPolicy,
          ttlMs: store.options.defaultTtlMs,
          staleMs: options.lease.staleMs,
          deletionChanged: options.errors.deletionChanged,
          rollbackChanged: options.errors.rollbackChanged,
          predicate: owner ? { kind: "leased", token: owner.token, value } : { kind: "absent" },
        },
        source: workerSource.admission.identity,
        assertCurrent() {
          workerSource.admission.assertCurrent();
          workerSource.maintenanceScope?.assertAdmission();
          store.assertCurrent?.();
          deletion.assertCurrent();
          if (owner?.failure || owner?.phase === "closed") {
            throw owner.failure ?? options.errors.lostLease(key);
          }
        },
        renewalPending: () => owner?.renewalPending() ?? false,
        joinRenewal: async () => {
          await owner?.joinRenewal();
        },
        quiesce: () => owner?.quiesce(),
        retain: (custodian) => {
          custody.add(custodian);
        },
        unknown: false,
        settle(outcome, error) {
          if (outcome === "unknown") {
            participant.unknown = true;
            const failure = error ?? new Error("Native binding settlement is unknown");
            if (owner) {
              owner.block(failure, participant);
            } else {
              leases.block(key, failure, participant);
            }
          } else if (owner) {
            owner.phase = outcome === "committed" ? "deleted" : "held";
          }
        },
      };
      participant.nativeMutation = createNativeSessionBindingNativeSettlement({
        plan: participant.binding!,
        env: store.options.env,
        assertCurrent: () => participant.assertCurrent(),
        settle: (outcome) => participant.settle(outcome),
      });
      return bindNativeSessionDeletionParticipant(mutation, participant);
    };
    if (!store || !workerSource || !workerSource.admission.identity.key.startsWith("file:")) {
      throw new Error("Native session binding deletion requires a worker-owned plugin-state store");
    }
    const workerMutation: AgentHarnessSessionDeletionMutation = {
      commit() {
        throw new Error(
          "Native session binding deletion must commit through its worker participant",
        );
      },
      rollback() {
        throw new Error(
          "Native session binding deletion must roll back through its worker participant",
        );
      },
    };
    return await withMutation(async () => {
      deletion.assertCurrent();
      const initial = await state.lookup(key);
      deletion.assertCurrent();
      if (initial === undefined) {
        return await run(undefined, bindParticipant(workerMutation));
      }
      return await leases.withLease(
        key,
        async () => {
          const owner = leases.owner(key)!;
          const stored = options.readRecord(await state.lookup(key));
          deletion.assertCurrent();
          deletion.assertRecordCurrent(stored);
          if (!stored) {
            throw new Error(options.errors.deletionChanged);
          }
          const { lease: _lease, ...expectedValue } = stored;
          return await run(stored, bindParticipant(workerMutation, expectedValue, owner));
        },
        deletion,
      );
    });
  };

  return {
    captureLeaseAssertion: leases.captureLeaseAssertion.bind(leases),
    transact: leases.transact,
    withLease: leases.withLease,
    hasLease: leases.hasLease,
    withMutation,
    withExclusiveMutationFence,
    withDeletion,
  };
}

type NativeSessionBindingLifecycleOptions<TRecord extends NativeSessionBindingRecord> = Omit<
  NativeSessionBindingLeaseConfig<TRecord>,
  "errors"
> & {
  /** Only bundled, audited codecs qualify for the worker storage participant. */
  workerCodec?: PluginStateNativeBindingCodec;
  errors: NativeSessionBindingLeaseConfig<TRecord>["errors"] & {
    mutationBlocked: string;
    conditionalDeletionRequired: string;
    deletionChanged: string;
    rollbackChanged: string;
  };
};

type NativeSessionBindingDeletionOptions<TRecord extends NativeSessionBindingRecord> =
  NativeSessionBindingLeaseOptions<TRecord> & {
    assertCurrent: () => void;
    assertRecordCurrent: (current: TRecord | undefined) => void;
  };

export type {
  NativeSessionBindingLeaseOptions,
  NativeSessionBindingStateStoreV2,
} from "./binding-leases.js";
