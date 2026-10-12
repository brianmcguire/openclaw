/** Production-private native session coordination for official harness plugins. */
export {
  createNativeSessionBindingLifecycleV2,
  type NativeSessionBindingLeaseOptions,
  type NativeSessionBindingStateStoreV2,
} from "../agents/harness/native-session/binding-lifecycle.js";
export {
  type NativeSessionGenerationReclaimPlan,
  type NativeSessionGenerationAdoptionResult,
} from "../agents/harness/native-session/binding-generation.js";
export {
  prepareNativeSessionGenerationAuthority,
  reclaimNativeSessionGenerationWithAuthority,
  resolveNativeSessionBindingWithAuthorityV2,
  type NativeSessionGenerationOperationsV2,
} from "../agents/harness/native-session/binding-generation-authority.js";
export { createNativeSessionInitializationOwner } from "../agents/harness/native-session/initialization.js";

export {
  createNativeSessionBindingAuthority,
  combineNativeSessionBindingAuthority,
  type NativeSessionBindingAuthority,
  type NativeSessionBindingWithCurrent,
} from "../agents/harness/native-session/binding-authority.js";
export {
  createNativeSessionCommitFinalizer,
  wrapNativeSessionDeletionMutation,
  isNativeSessionDeletionUnresolved,
} from "../agents/harness/native-session/deletion-participant.js";
