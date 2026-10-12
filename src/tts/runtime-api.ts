// Runtime speech API barrel for TTS preferences, synthesis, streaming, and test
// helpers used by speech-capable plugins.
import type { TtsProvider } from "../config/types.js";
import { parseTtsDirectives } from "./directives.js";
import { summarizeText } from "./tts-core.js";
import {
  getResolvedSpeechProviderConfig,
  resolveTtsProviderAsync,
} from "./tts-provider-resolution.js";
import { resolveModelOverridePolicy, type ResolvedTtsConfig } from "./tts-settings.js";
import { formatTtsProviderError, sanitizeTtsErrorForLog } from "./tts-synthesis-support.js";
import {
  resolveTtsSynthesisTarget,
  shouldDeliverTtsAsVoice,
  supportsNativeVoiceNoteTts,
  supportsTranscodedVoiceNoteTts,
} from "./tts-synthesis.js";

export { setSpeechRuntimeAvailabilityGuard } from "./runtime-availability.js";
export {
  buildTtsSystemPromptHint,
  getTtsMaxLength,
  getTtsPersona,
  isSummarizationEnabled,
  isTtsEnabled,
  listTtsPersonas,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPathAsync,
  setTtsMachinePrefsPathResolver,
  type ResolvedTtsConfig,
  type ResolvedTtsModelOverrides,
} from "./tts-settings.js";
export {
  setSummarizationEnabled,
  setTtsAutoMode,
  setTtsEnabled,
  setTtsMaxLength,
  setTtsPersona,
  setTtsProvider,
} from "./tts-settings-writes.js";
export { getLastTtsAttempt, listSpeechVoices, setLastTtsAttempt } from "./tts-payload.js";
export {
  getResolvedSpeechProviderConfig,
  isTtsProviderConfiguredAsync,
  resolveTtsProviderOrder,
} from "./tts-provider-resolution.js";
export { prepareTtsRequest, resolveExplicitTtsOverridesAsync } from "./tts-request.js";
export { streamSpeech, textToSpeechStream } from "./tts-streaming.js";
export { synthesizeSpeech } from "./tts-synthesis.js";
export { textToSpeechTelephony } from "./tts-telephony.js";
export type { TtsDirectiveOverrides, TtsDirectiveParseResult } from "./provider-types.js";
export type {
  TtsStreamResult,
  TtsSynthesisResult,
  TtsSynthesisStreamResult,
  TtsTelephonyResult,
} from "./tts-runtime-types.js";

export async function getTtsProviderAsync(
  config: ResolvedTtsConfig,
  prefsPath: string,
): Promise<TtsProvider> {
  return await resolveTtsProviderAsync(config, prefsPath);
}

export const testApi = {
  parseTtsDirectives,
  resolveModelOverridePolicy,
  supportsNativeVoiceNoteTts,
  supportsTranscodedVoiceNoteTts,
  resolveTtsSynthesisTarget,
  shouldDeliverTtsAsVoice,
  summarizeText,
  getResolvedSpeechProviderConfig,
  formatTtsProviderError,
  sanitizeTtsErrorForLog,
};
