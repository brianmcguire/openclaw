import { setImmediate } from "node:timers/promises";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { expect, it, onTestFinished, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { pluginInstanceInvocation } from "../../../src/plugins/plugin-instance-invocation.js";
import { PluginInstance } from "../../../src/plugins/plugin-instance.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { setTelegramRuntime } from "./runtime.js";
import { createTelegramIngressWorker } from "./telegram-ingress-worker.js";
import { writeTelegramUpdateOffset } from "./update-offset-store.js";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    // Keep the real native Worker and adapter; replace only the network sidecar.
    resolveRuntimeWorkerUrl: () =>
      new URL("./telegram-ingress-worker.context.test-support.mjs", import.meta.url),
  };
});

it("keeps immediate and deferred offset writes with each Worker's construction owner", async ({
  signal,
}) => {
  const registrationOwner = new PluginInstance("unrelated-registration");
  onTestFinished(async () => {
    await registrationOwner.dispose();
  });

  async function runOwner() {
    const owner = new PluginInstance("telegram");
    onTestFinished(async () => {
      await owner.dispose();
    });
    const writes: Array<{ owner: unknown; key: string; value: unknown }> = [];
    return owner.run(async () => {
      setTelegramRuntime(
        createPluginRuntimeMock({
          state: {
            openKeyedStore<T>({ namespace }: { namespace: string }): PluginStateKeyedStore<T> {
              expect(namespace).toBe("telegram.update-offsets");
              return {
                async register(key: string, value: T) {
                  writes.push({ owner: pluginInstanceInvocation.getStore()?.instance, key, value });
                },
                registerIfAbsent: async () => false,
                lookup: async () => undefined,
                consume: async () => undefined,
                delete: async () => false,
                entries: async () => [],
                clear: async () => {},
              };
            },
          },
        }),
      );
      const handle = createTelegramIngressWorker({
        token: "123456:fixture",
        accountId: "default",
        initialUpdateId: null,
      });
      const completed = createDeferred();
      registrationOwner.run(() => {
        handle.onMessage = (message) => {
          if (message.type !== "spooled") {
            return;
          }
          void (async () => {
            await writeTelegramUpdateOffset({ updateId: message.updateId });
            await setImmediate();
            await writeTelegramUpdateOffset({ updateId: message.updateId + 1 });
          })().then(completed.resolve, completed.reject);
        };
      });
      try {
        await withinTest(completed.promise, signal);
      } finally {
        await handle.stop();
      }
      expect(writes).toEqual([
        { owner, key: "default", value: expect.objectContaining({ lastUpdateId: 7 }) },
        { owner, key: "default", value: expect.objectContaining({ lastUpdateId: 8 }) },
      ]);
    });
  }

  const results = await Promise.allSettled([runOwner(), runOwner()]);
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
});
