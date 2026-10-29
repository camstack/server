/**
 * Lightweight addon-authoring + addon-runner entry point.
 *
 * Importing the root barrel (`@camstack/types`) eagerly constructs the entire
 * schema graph (~1963 `z.object/enum/union(...)` builders across 378 files),
 * costing ~47MB of V8 heap PER process. Every forked addon-runner paid that
 * even though it only needs a handful of runtime helpers — 8 runners ≈ 1.4GB
 * on the agent. There is no runtime tree-shaking in Node, and the package is
 * externalized (loaded as the prebuilt barrel), so the bundler cannot drop the
 * unused schemas. This subpath is the manual fix: it pulls ONLY the light,
 * schema-free modules the runner + addons actually need at runtime.
 *
 * Each symbol below is imported from its DEEP source module (not the barrel and
 * not `generated/capability-router-map`, which re-exports all 266 capabilities)
 * so this entry's runtime graph stays small.
 *
 * See memory: camstack_runner_ram_and_build_rootcause.
 */

// --- Addon-authoring surface (BaseAddon + the admin-ui capability) ---
export { BaseAddon, normalizeAddonInitResult } from './addon/base-addon.js'
export { ErrorI18nPayloadSchema, readErrorI18n } from './i18n/camstack-error.js'
export type { ErrorI18nPayload } from './i18n/camstack-error.js'
export { nodePin, readNodePin } from './cap-call-context.js'
// --- Type-only re-exports (erased at runtime, zero cost) ---
export type { IAdminUiProvider } from './capabilities/admin-ui.cap.js'
export { adminUiCapability } from './capabilities/admin-ui.cap.js'
export { expandCapMethods } from './capabilities/capability-definition.js'
// The custom-action catalog describer. Runtime VALUE, and the kernel's
// `custom-action-registry` needs it inside the runner closure — importing it
// from the root barrel pulled the whole schema graph in with it (D28, ~146 MB
// RSS per forked runner). Safe here: `custom-actions.ts` imports zod
// TYPE-only, so it adds no schema construction to this entry's graph.
export {
  customAction,
  defineCustomActions,
  describeCustomActions,
} from './capabilities/custom-actions.js'
// Schema-light pipeline run shapes (own module, not `pipeline-executor.cap`).
export {
  PipelineRunResultBridge,
  PipelineStepInputSchema,
} from './capabilities/pipeline-step-input.js'
export type { PipelineStepInputOutput } from './capabilities/pipeline-step-input.js'
export { defineRecordKinds } from './records/record-kind.js'
export { addonPagesSourceCapability } from './capabilities/addon-pages-source.cap.js'
// Schema-free list the transport uses to strip spoofable caller stamps (D28).
export {
  CALLER_STAMPED_CAPABILITIES,
  withoutCallerStamp,
} from './capabilities/caller-stamp.js'
export { deviceOpsCapability } from './capabilities/device-ops.cap.js'
export type { IViewerUiProvider } from './capabilities/viewer-ui.cap.js'
export { viewerUiCapability } from './capabilities/viewer-ui.cap.js'
// The batch bound both ends of `getChildrenBatch` share. From its schema-free
// module, never from `device-manager.cap.js` — that path would re-drag the cap
// schema graph onto this entry and undo D28.
export { DEVICE_CHILDREN_BATCH_MAX } from './device/children-batch-max.js'
export { DeviceType } from './device/device-type.js'
// D783 — the runner reports a device's declared secret config paths at
// `registerDevice`. Schema-free: reads `z.globalRegistry`, builds no schema.
export { collectZodSecretPaths, isZodSecret } from './device/zod-secret.js'
export { DisposerChain } from './disposer-chain.js'
// The Hugging Face model-hosting facts the model downloader needs. Each from its
// schema-free module — `constants.ts` and `utils/hf-url.ts` import nothing, and
// `types/model-formats.ts` is split out of `types/models.ts` (which builds Zod).
// Reached through the root barrel these dragged the whole schema graph into
// `@camstack/system/addon-utils` (~105 MB per runner).
export { HF_REPO } from './constants.js'
export { MODEL_FORMATS } from './types/model-formats.js'
export { hfModelUrl } from './utils/hf-url.js'
// The addon→addon byte transport (D613). From its DEEP module, never the
// barrel: `addon-peer-bytes-facility.ts` reached for `@camstack/types` and
// pulled the whole schema graph into every forked runner — the ~146MB per
// runner this subpath exists to prevent (D28).
export {
  PEER_BYTES_CHUNK_BYTES,
  PEER_BYTES_MAX_OUTSTANDING,
  PEER_BYTES_STALL_MS,
  PEER_BYTES_TICKET_TTL_MS,
} from './interfaces/addon-peer-bytes.js'
export type * from './interfaces/addon-peer-bytes.js'
export { EventCategory } from './enums/event-category.js'
// Plain-data cap input defaults — a `.default()` only runs where the schema is
// PARSED (the tRPC router), and an addon's `ctx.api` call never goes there.
export { CAP_INPUT_DEFAULTS, withCapInputDefaults } from './generated/cap-input-defaults.js'
export {
  COLLECTION_ARRAY_METHODS,
  PROVIDER_OPTIONAL_METHODS,
  isCollectionArrayMethodName,
  isProviderOptionalMethodName,
} from './generated/collection-array-methods.js'
// Schema-free capability facts for addon SERVER code (codegen'd): an addon that
// reached for `ALL_CAPABILITY_DEFINITIONS` inlined every cap's Zod schema and paid
// ~+100 MB of heap per runner for two lookups.
export { CAP_ADVANCE_FIELDS, CAP_STATE_LEAVES } from './generated/addon-cap-facts.js'
export type { CapStateLeaf } from './generated/addon-cap-facts.js'
export { createDeviceProxy } from './generated/device-proxy.js'
export { createEventBusSliceSource } from './device/device-state-handle.js'
export type { SliceEventBus, SliceHandleApi } from './device/device-state-handle.js'
export { addonSliceHandleApi } from './helpers/addon-slice-handle.js'
// Plain data, for the same reason: a forked runner asks "may a rule actuate
// this cap?" without pulling the schema barrel in (D28).
export { DEVICE_SCOPED_CAPS, isDeviceScopedCap } from './generated/device-scoped-caps.js'
export type {
  AddonDeclaration,
  AddonInitResult,
  ICamstackAddon,
  ProviderRegistration,
} from './interfaces/addon.js'
export { DATAPLANE_SECRET_HEADER } from './interfaces/addon-data-plane.js'
export { createEvent, emitReadiness } from './interfaces/event-bus.js'
export {
  ReadinessRegistry,
  ReadinessTimeoutError,
  scopeKey,
} from './readiness/readiness-registry.js'
// The ONE retry schedule for work that can fail simply because the node was
// still booting — see `util/boot-recovery-backoff.ts`. Exposed on the addon
// surface because addons arm boot-time retries too (Tailscale auto-rejoin).
export { BOOT_RECOVERY_BACKOFF_MS } from './util/boot-recovery-backoff.js'
// --- Runner runtime surface (the 8 files in the addon-runner closure) ---
export { errMsg } from './utils/err-msg.js'
export { maskUrlCredentials } from './utils/mask-url.js'
export { asJsonObject, asString, parseJsonUnknown } from './utils/json-safe.js'
export { sleep } from './utils/sleep.js'
// --- Keychain (D787): the ref / marker contract, `ctx.secrets`, the log
// scrubber's known-value set. All schema-free (the cap schemas are imported
// type-only), so the runner closure stays small.
export * from './keychain/index.js'
// D881 - `ctx.records`: the facade, the kind declarations and the named failures. Light on
// purpose: zod schemas of a few fields, no capability schema graph (D28).
export * from './records/index.js'
