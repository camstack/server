export { ReolinkProviderAddon } from './addon.js'
// The hub-side registry resolves a forked addon's custom-action catalog via
// the module's `customActions` NAMED export (see addon-registry
// loadForkedCustomActionCatalog) — same wiring as addon-benchmark/notifiers.
export { reolinkDebugActions as customActions } from './debug-actions.js'
export { ReolinkCamera, reolinkCameraSchema } from './reolink-camera.js'
