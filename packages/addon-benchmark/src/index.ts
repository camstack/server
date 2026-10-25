export { BenchmarkAddon } from './benchmark-addon.js'
// Re-export the custom-action catalog so the hub can register them in
// its CustomActionRegistry without instantiating the addon (the catalog
// is static: real zod schemas, not a passthrough). Kernel conventions
// look up `customActions` on the module when loading an addon.
export { benchmarkActions as customActions } from './benchmark-actions.js'
