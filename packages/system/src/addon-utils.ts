/**
 * Lightweight addon-facing utility surface for `@camstack/system`.
 *
 * Importing the root barrel (`@camstack/system`) loads the ENTIRE framework —
 * the kernel (moleculer) + every builtin addon (sqlite-storage, winston-logging,
 * device-manager, …) — ~64MB of V8 heap PER process, even when an addon only
 * needs a model-download or data-plane helper. Node has no runtime tree-shaking
 * and the package is host-provided (loaded as the prebuilt barrel), so every
 * addon that imported one util from the barrel paid the full ~64MB — multiplied
 * across every forked pipeline runner.
 *
 * This subpath re-exports ONLY the addon-facing helpers, each from its DEEP,
 * kernel-free source module, so importing it costs a few MB instead of ~64MB.
 *
 * See memory: camstack_runner_ram_and_build_rootcause.
 */
export {
  adoptModelRevisions,
  downloadFile,
  ensureModel,
  isModelDownloaded,
  resolveFormatRevision,
  type ModelRevisionAdoption,
  deleteModelFromDisk,
  collectModelFiles,
  getModelFilePath,
  isModelDownloadHttpError,
  ModelDownloadHttpError,
  type DownloadFileOptions,
  type DownloadRedirectPolicy,
} from './download/model-downloader.js'
export { ModelDownloadService } from './download/model-download-service.js'
export { createFileDataPlaneHandler } from './http/file-data-plane.js'
// Range/content-type primitives for addons that serve files with a CUSTOM
// handler (e.g. the recorder's export download, which must observe the
// final-byte delivery to record delete-after-download). Deep, kernel-free
// import — same cheap module the data-plane helper itself reuses.
export {
  parseRangeHeader,
  contentTypeFor,
  type ByteRange,
} from './http/authenticated-file-server.js'
export { CustomActionRegistry } from './kernel/custom-action-registry.js'
// Event-loop stall attribution. Deep, kernel-free (`node:perf_hooks` and a type
// import), and needed by FOUR processes in three bundles — `detection-pipeline`,
// `recorder`, `pipeline-analytics` and hub-main — which is why it lives here
// rather than in one of them. See D417.
export {
  attributeStall,
  STALL_REPORT_MS,
  STALL_TICK_MS,
  startEventLoopStallMonitor,
  type StallVerdict,
} from './kernel/event-loop-stall-monitor.js'
// The state treatment for a camera that cannot produce a current frame — the
// PICTURE half of the stream-broker's sentry, and of the snapshot wrapper's
// courtesy answer. Deep, kernel-free (sharp and an inline SVG; D118 forbids
// ffmpeg `drawtext`, only one of the hub's two ffmpeg builds has libfreetype),
// and needed by a SECOND bundle now that `addon-pipeline` paints the "Waking"
// frame it emits while a lazy camera builds its stream. Exported here rather
// than copied, because a second renderer would be a second answer to "what does
// a camera that cannot answer look like".
export {
  renderCourtesyJpeg,
  renderCourtesyOverlayJpeg,
  courtesyCacheKey,
  COURTESY_DEFAULT_WIDTH,
  type CourtesyReason,
  type CourtesyFrameSpec,
} from './builtins/snapshot/snapshot-courtesy.js'
