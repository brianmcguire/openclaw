import { withClaimingHookAdmission } from "../../plugins/hook-claim-admission.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import { admittedSessionSettingsRestrictRuntime } from "./dispatch-from-config.events.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";

export function runReplyDispatchHook(
  state: PrepareDispatchOperationReadyState,
  options: {
    shouldSendToolSummariesAsync: () => Promise<boolean>;
    isTailDispatch?: true;
  },
) {
  const { hookRunner, params } = state;
  if (
    !state.allowInboundHandlers ||
    admittedSessionSettingsRestrictRuntime(params.replyOptions?.admittedSessionSettings) ||
    !hookRunner?.hasHooks("reply_dispatch", { dispatchKind: state.dispatchKind })
  ) {
    return undefined;
  }
  const run = () =>
    state.runWithDispatchLifecycleAdmission(async () => {
      return await runWithDispatchAbortSignal(
        // Reset tails have entered dispatch admission; initial takeover still owns the pre-dispatch lease.
        options.isTailDispatch ? state.getDispatchAbortSignal() : state.getPreDispatchAbortSignal(),
        async () => {
          state.assertProgressCurrent();
          return hookRunner.runReplyDispatch(
            {
              ctx: state.ctx,
              runId: params.replyOptions?.runId,
              sessionKey: state.acpDispatchSessionKey,
              toolsAllow: params.replyOptions?.toolsAllow,
              images: params.replyOptions?.images,
              inboundAudio: state.inboundAudio,
              sessionTtsAuto: state.sessionTtsAuto,
              ttsChannel: state.deliveryChannel,
              suppressUserDelivery: state.suppressHookUserDelivery,
              suppressReplyLifecycle: state.suppressHookReplyLifecycle,
              sourceReplyDeliveryMode: state.sourceReplyDeliveryMode,
              shouldRouteToOriginating: state.shouldRouteToOriginating,
              originatingChannel: state.routeReplyChannel,
              originatingTo: state.routeReplyTo,
              originatingAccountId: state.replyContextAccountId,
              originatingThreadId: state.routeReplyThreadId,
              originatingChatType: state.replyRoute.chatType,
              shouldSendToolSummariesAsync: options.shouldSendToolSummariesAsync,
              shouldSendFullToolDetailsAsync: state.shouldEmitFullVerboseProgressAsync,
              sendPolicy: state.sendPolicy,
              ...(options.isTailDispatch ? { isTailDispatch: true } : {}),
            },
            withClaimingHookAdmission(
              {
                cfg: state.cfg,
                dispatchKind: state.dispatchKind,
                dispatcher: state.dispatchHookDispatcher,
                abortSignal: state.getPreDispatchAbortSignal() ?? params.replyOptions?.abortSignal,
                onReplyStart: params.replyOptions?.onReplyStart,
                onAgentRunStart: params.replyOptions?.onAgentRunStart,
                onPreparedAgentRunStart: params.replyOptions?.onPreparedAgentRunStart,
                userTurnTranscriptRecorder: params.replyOptions?.userTurnTranscriptRecorder,
                prepareAssistantTranscriptMessage:
                  params.replyOptions?.prepareAssistantTranscriptMessage,
                recordProcessed: state.recordProcessed,
                markIdle: state.markIdle,
              },
              options.isTailDispatch ? undefined : { prepare: state.assertCurrentBindingRoute },
            ),
          );
        },
        state.trackDispatchLifecycleWork,
      );
    });
  return options.isTailDispatch ? run() : state.traceReplyPhase("reply.reply_dispatch_hooks", run);
}
