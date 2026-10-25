/**
 * Camera Grids — composite cameras built from other cameras.
 *
 * The manifest `entry` points at THIS module's build (`./dist/index.js`), and
 * `vite.config.ts` must carry an `entries` key for every module a manifest
 * names — a manifest entry is just a string and nothing resolves it at build
 * time, so a missing key compiles and fails at runtime.
 * `scripts/check-addon-entries.ts` is what catches that.
 */
export { CameraGridAddon } from './addon.js'
export { CameraGridAddon as default } from './addon.js'
export { buildGridFilterGraph } from './grid-filter-graph.js'
export type {
  GridCell,
  GridFilterGraph,
  GridLayout,
  NormalizedRect,
} from './grid-filter-graph.js'
export {
  buildGridCameraDeclarations,
  gridCameraReconciliationIndex,
  newGridCameraStableId,
} from './grid-camera-declarations.js'
export type {
  ExistingGridCameraRow,
  GridCameraConfig,
  GridCameraDeclaration,
} from './grid-camera-declarations.js'
export { GridCameraDevice, installGridCameraRuntime } from './grid-camera-device.js'
export type { GridCameraRuntime } from './grid-camera-device.js'
export { readGridInstances } from './grid-instances.js'
export type { GridCellConfig, GridInstance } from './grid-instances.js'
export { gridPlanFor } from './grid-plan.js'
export type { GridPlanEncodeContext } from './grid-plan.js'
export { normalizeGridRows } from './grid-row-normalization.js'
export type { NormalizedGridRows } from './grid-row-normalization.js'
export { gridStreamDescriptor } from './grid-stream-descriptor.js'
export {
  GRID_CAM_STREAM_ID,
  GRID_PROFILES,
  gridCamStreamId,
  gridProfilePlans,
} from './grid-profiles.js'
export type { GridProfilePlan, ServedProfile } from './grid-profiles.js'
export { deriveGridCanvas } from './grid-canvas-derivation.js'
export { gridSourceDial } from './grid-sentry-sources.js'
export type { GridSourceAcquisition, GridSourceDial } from './grid-sentry-sources.js'
export { GridSnapshotSource, gridSnapshotAnswerFor } from './grid-snapshot.js'
export type {
  GridLastFrameStore,
  GridSnapshotAnswer,
  GridSnapshotDeps,
  GridSnapshotImage,
  GridSnapshotSession,
} from './grid-snapshot.js'
export { GridLastFrameFileStore } from './grid-last-frame-store.js'
export { GridFrameSampler } from './grid-frame-sample.js'
export type { GridFrameSource, GridSpawn } from './grid-frame-sample.js'
export type { GridStreamDescriptorInput } from './grid-stream-descriptor.js'
export { gridStreamInvocation } from './grid-stream-invocation.js'
export type { GridStreamInvocationInput, GridStreamSource } from './grid-stream-invocation.js'
export { GridStreamRelay, parseGridStreamPath } from './grid-stream-relay.js'
export type { GridStreamRelayDeps, GridStreamRequest } from './grid-stream-relay.js'
export { GridStreamSession } from './grid-stream-session.js'
export type {
  GridSourceHandle,
  GridStreamChild,
  GridStreamConsumer,
  GridStreamHold,
  GridStreamLogger,
  GridStreamPlan,
  GridStreamSessionDeps,
  GridStreamSessionOptions,
} from './grid-stream-session.js'
export { startGridChild } from './grid-child.js'
export type { GridChildContext } from './grid-child.js'
export { GRID_SILENCED_CAP_NAMES, silenceAnalysisFor } from './silence-analysis.js'
export type { SilenceAnalysisDeps } from './silence-analysis.js'
