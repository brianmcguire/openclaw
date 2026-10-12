---
summary: "Draft migration for the next Plugin SDK major's synchronous SQLite removals"
read_when:
  - Preparing a plugin for the next Plugin SDK major
  - Replacing synchronous SQLite-backed plugin APIs
---

# Next-major SQLite migration draft

This document describes an unmerged SDK-major proposal. It does not announce a
release or shorten the current compatibility window. The removals require the
maintainer's explicit SDK-major decision before they can ship.

The proposed cutover removes deprecated synchronous entrypoints whose bundled
callers already use their replacements. Shared native kernels remain where they
serve workers, boot admission, offline maintenance, or a current bundled caller.
An `Async` suffix means callers must await completion; it is not permission to
run raw SQLite on the Gateway thread.

## Migrate removed calls

| Deprecated contract                                                                                                  | Replacement                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadArchivedSessions`, `resolveMemorySessionTargets`                                                                | Await the corresponding `Async` reader from `memory-core-host-engine-sessions`.                                                                          |
| `loadMemorySessionMetadata`, `loadMemorySessionMetadataBatch`                                                        | Await the corresponding `Async` metadata reader.                                                                                                         |
| `resolveConfiguredCapabilityProvider`, `resolveCapabilityModelCandidates`, `resolveConfiguredRealtimeVoiceProvider`  | Await the corresponding `Async` resolver.                                                                                                                |
| `resolveStoredModelOverride`, `resolveCommandArgMenu`                                                                | Await the corresponding `Async` resolver.                                                                                                                |
| Auth profile metadata/upsert/local-update helpers and model header/CLI eligibility helpers                           | Await the corresponding `Async` operation. Core credential authority continues to use its existing owner.                                                |
| TTS provider, availability, explicit override, and preferences-path helpers                                          | Await the corresponding `Async` helper.                                                                                                                  |
| `readChannelAllowFromStoreSync`                                                                                      | Await `readChannelAllowFromStore`.                                                                                                                       |
| `resolveInboundSessionEnvelopeContext`                                                                               | Await `resolveInboundSessionEnvelopeContextAsync`.                                                                                                       |
| `inbound-envelope` callback builders                                                                                 | Resolve the route, then await `createChannelInboundEnvelopeBuilderAsync` from `channel-inbound`. Use its prepared formatter for that message.            |
| `resolveInboundDirectDmAccessWithRuntime`, `createPreCryptoDirectDmAuthorizer`, `dispatchInboundDirectDmWithRuntime` | Use the awaited direct-DM access and dispatch APIs.                                                                                                      |
| `resolveDmGroupAccessWithLists`                                                                                      | Await `resolveDmGroupAccessWithListsAsync`.                                                                                                              |
| `deleteSessionUpstreamLink`                                                                                          | Await `deleteSessionUpstreamLinkAsync`.                                                                                                                  |
| Synchronous Codex transcript admission/version validators                                                            | Use `createCodexSessionContextReader` and its awaited reader operations.                                                                                 |
| Legacy SQLite database/callback wrappers                                                                             | Open `openOpenClawAgentSqliteWorkerStoreV2` with host authority and send serializable domain commands. Worker backends use `sqlite-worker-runtime`.      |
| `loadCombinedSessionStoreForGateway`                                                                                 | Await `loadCombinedSessionStoreForGatewayAsync`. The result still excludes incognito entries.                                                            |
| `getConversationSession`, `readAmbientTranscriptWatermark`, `readSessionUpdatedAt`, `readTranscriptStatsSync`        | Await the corresponding async reader, including `readTranscriptStatsAsync` for statistics.                                                               |
| `listSkillCommandsForAgents`, `listSkillCommandsForWorkspace`                                                        | Await `prepareSkillCommandsForAgents` or `prepareSkillCommandsForWorkspace`.                                                                             |
| `loadExecApprovals` from `exec-approvals-runtime`                                                                    | Await `loadExecApprovalsReadOnlyAsync`.                                                                                                                  |
| `buildWatchedSessionsHarnessContext`                                                                                 | Await `prepareWatchedSessionsHarnessContext` with the current host authority.                                                                            |
| `createOpenClawCodingTools`, `AgentHarnessHostCapabilities.createToolSurface`                                        | Await the corresponding `Async` factory.                                                                                                                 |
| `OpenClawPluginNodeHostCommandContext.acquireManagedWorkspace`                                                       | Await `acquireManagedWorkspaceAsync` and release the lease in `finally`.                                                                                 |
| `approvalEvents.publishRequested`                                                                                    | Await `approvalEvents.publishRequestedAsync`; asynchronous subscriber eligibility is required.                                                           |
| Mention Inbox `list`, `dismiss`, `recordCommittedInput`, `invalidate`                                                | Await the corresponding `Async` method.                                                                                                                  |
| Model-account `listLinks`, `link`, `unlink`, `list`, `select`, `status`, `cancel`                                    | Await the corresponding `Async` method.                                                                                                                  |
| Session observer `handleEvent`, `getCompanionSnapshot`, `dispose`                                                    | Await the corresponding `Async` method.                                                                                                                  |
| SessionManager synchronous persistence and context methods                                                           | Await the corresponding `Async` method, including completion of a returned rewrite commit.                                                               |
| `ExtensionAPI.appendEntry`, `setSessionName`, `setLabel`; `AgentSession.setSessionName`                              | Await the corresponding `Async` method. Use `ExtensionActionsV2`, `ExtensionRuntimeV2`, and `bindCoreV2` when supplying extension capabilities.          |
| GitHub publication legacy methods and requester callbacks                                                            | Use the V2 requester/action types and await the `V2` or `Async` operations.                                                                              |
| Reply dispatch visibility booleans and `onVerboseProgressVisibility`                                                 | Await `shouldSendToolSummariesAsync`, `shouldSendFullToolDetailsAsync`, and `onVerboseProgressVisibilityAsync`.                                          |
| Transcript write-lock helpers and transaction-local message preparation callbacks                                    | Use `withSessionTranscriptWrite` or `withCodexSessionTranscriptMirrorWrite`; supply `preparation.prepareMessage` and its source authority.               |
| `ProviderPlugin.sanitizeReplayHistory`, `sanitizeGoogleGeminiReplayHistory`                                          | Use the `Async` hook/helper and the V2 replay context.                                                                                                   |
| `ProviderReplaySessionState`, `ProviderSanitizeReplayHistoryContext`                                                 | Use the V2 types and await `appendCustomEntryAsync`.                                                                                                     |
| Native proxy capture store/reader APIs and synchronous capture callbacks                                             | Use `acquireDebugProxyCaptureStoreAsync`, release its lease, and await the async reader, initialization, capture, and finalization operations.           |
| Synchronous user-turn and pending-input completion receipts                                                          | Await `completeProcessingAsync` or `completeAsync`.                                                                                                      |
| `ensureAgentWorkspace.beforePersistentApply`                                                                         | Prepare database inputs first; retain SQL-free host authority at the effect.                                                                             |
| Opaque approval commit callbacks with transaction-local row visibility                                               | Use host-bound `api.runtime.gateway.request` approval methods. Final authority checks remain in force; callbacks cannot inspect uncommitted worker rows. |

Await writes before publishing dependent state. Do not catch an async failure and
retry through a retired synchronous API. Move custom SQL into a registered
worker backend; do not move an opaque JavaScript transaction closure across the
thread boundary.

## Remaining blockers

This proposal is not the complete elimination of main-thread SQLite. Several
published contracts still have bundled consumers or share an owner that needs a
separate migration:

- Raw `openNodeSqliteDatabase`, `getNodeSqliteKysely`, `executeSqliteQuerySync`, and
  `runSqliteImmediateTransactionSync` still serve bundled memory/database code.
- Keyed-state legacy stores still serve Discord, Telegram, ClickClack, Codex,
  Matrix, AgentsAPI, and retained Reef migration data.
- Synchronous authentication helpers still serve provider plugins. Final
  credential, approval, tool, command, external-effect, and cross-user authority
  checks must remain current.
- Session entry and ACP readers still serve bundled bindings and exact authority
  checks. Codex's synchronous runtime-ownership hook remains in use.
- The account binding service still consumes internal synchronous adapter
  operations. Removing the legacy public factories does not remove those shared
  native kernels.
- Core transcript preparation, workspace guards, session persistence, and
  prepared callback types must not be deleted solely because an SDK wrapper was
  retired.
- `patchSessionEntry` and `updateSessionStoreEntry` retain core plugin-registry
  consumers. Synchronous skill library selection remains reachable through
  `loadWorkspaceSkills`.
- Command authorization, conversation-binding inspection, and native channel
  approval adapter factories retain bundled consumers. Migrating preparation
  must preserve their final authority checks.

The proposal's pull request records exact callers, compatibility dates, API-diff
results, and live versus compatibility T1 counts. Those static counts describe
reachable call sites, not statements executed in a warmed turn.
