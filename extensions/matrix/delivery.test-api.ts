// Vitest-only entry point for core-owned Matrix delivery composition tests.
export {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./src/matrix/monitor/handler.test-helpers.js";
export {
  createRecordingMatrixClient,
  installMatrixDeliveryTraceRuntime,
} from "./src/delivery-trace.test-support.js";
