import { vi } from "vitest";
import { resolveSessionEntryResetFreshnessAsync } from "../../config/sessions/entry-freshness.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export function createPluginSessionRuntimeMock() {
  return {
    resolveStorePath: vi.fn<PluginRuntime["channel"]["session"]["resolveStorePath"]>(
      () => "/tmp/sessions.json",
    ),
    readSessionUpdatedAtAsync: vi.fn<
      PluginRuntime["channel"]["session"]["readSessionUpdatedAtAsync"]
    >(async () => undefined),
    recordSessionMetaFromInbound:
      vi.fn<PluginRuntime["channel"]["session"]["recordSessionMetaFromInbound"]>(),
    recordInboundSession: vi.fn<PluginRuntime["channel"]["session"]["recordInboundSession"]>(),
    updateLastRouteWithAuthority:
      vi.fn<PluginRuntime["channel"]["session"]["updateLastRouteWithAuthority"]>(),
    updateLastRoute: vi.fn<PluginRuntime["channel"]["session"]["updateLastRoute"]>(),
    resolveEntryResetFreshnessAsync: vi.fn(resolveSessionEntryResetFreshnessAsync),
  };
}
