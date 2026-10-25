export { AiAddon, default } from './addon.js'
export {
  createLlmClient,
  type LlmCallRequest,
  type LlmClient,
} from './client/llm-client.js'
export {
  CONSUMER_RETRY_POLICY,
  resolveRetryPolicy,
} from './client/retry-policy.js'
export {
  AI_ADDON_ID,
  createLlmProvider,
  type LlmProviderDeps,
  type RuntimeClient,
} from './provider.js'
export {
  ensureLlamaServer,
  LLAMA_SERVER_VERSION,
  llamaServerAsset,
} from './runtime/ensure-llama-server.js'
export { type LlamaStartConfig, LlamaSupervisor } from './runtime/llama-supervisor.js'
export {
  catalogById,
  entryForRef,
  LLM_MODEL_CATALOG,
  type LlmManagedModel,
} from './runtime/llm-model-catalog.js'
export { createDefaultModelOps } from './runtime/model-ops.js'
export {
  createLlmRuntimeProvider,
  type LlmRuntimeProviderDeps,
  type RuntimeModelOps,
} from './runtime/runtime-provider.js'
export { createRuntimeClient, type RuntimeApi } from './runtime-client.js'
export { aiRecordKinds, USAGE_RETENTION_MS } from './record-kinds.js'
export {
  CHATS_COLLECTION,
  ChatStore,
  chatsRowId,
  titleFromFirstUserMessage,
  type ChatRetention,
  type ChatSummary,
  type StoredChatMessage,
  type StoredConversation,
} from './test-chat/chat-store.js'
export {
  encodeEvent,
  TEST_CHAT_CONNECT_TIMEOUT_MS,
  TEST_CHAT_CONSUMER,
  TEST_CHAT_DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  TEST_CHAT_IDLE_TIMEOUT_MS,
  TEST_CHAT_MAX_FIRST_TOKEN_TIMEOUT_MS,
  TEST_CHAT_MIN_VISION_INPUT_TOKENS,
  TEST_CHAT_PREFIX,
  type TestChatAttachment,
  type TestChatEvent,
  TestChatEventSchema,
  type TestChatImageRef,
  type TestChatMessage,
  type TestChatPhase,
  type TestChatRequest,
  TestChatRequestSchema,
} from './test-chat/contract.js'
export {
  type MediaDeps,
  pickTrackMedia,
  renderTranscript,
  resolveImage,
  TRACK_MEDIA_PREFERENCE,
  type TrackMediaRow,
  type VisionImage,
} from './test-chat/media.js'
export {
  createTestChatPlaneHandler,
  type TestChatPlaneDeps,
} from './test-chat/plane.js'
export {
  type EmitEvent,
  type OpenStreamOutcome,
  runTestChatStream,
  type StreamChunk,
  type StreamRequest,
  type TestChatStreamDeps,
} from './test-chat/run-stream.js'
export type { BudgetGate, UsageFilter, UsageRecorder, UsageRowInput } from './usage/usage-port.js'
export { USAGE_COLLECTION, UsageStore } from './usage/usage-store.js'
