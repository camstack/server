/**
 * Public surface of @camstack/nx-plugin.
 *
 * The executor + generator are referenced by name through the
 * `executors.json` / `generators.json` manifest files at the package
 * root — those are the entry points Nx itself looks at. This barrel
 * is here for downstream code that wants to consume the helpers
 * programmatically (e.g. a CI tool that wraps `packAddon` +
 * `uploadAddon` without going through Nx).
 */
export { resolveDeployConfig, parseRc } from './lib/resolve-config.js'
export type { ResolvedDeployConfig, ResolveInputs } from './lib/resolve-config.js'
export { packAddon } from './lib/pack-addon.js'
export type { PackResult } from './lib/pack-addon.js'
export { uploadAddon } from './lib/upload-addon.js'
export type { UploadInputs, UploadResult } from './lib/upload-addon.js'

// Re-export the executor as the package's default consumable. Useful
// when invoked through the `Executor` programmatic API (rare; most
// callers go through `nx run …:deploy`).
export { default as deployExecutor } from './executors/deploy/executor.js'
export type { DeployExecutorSchema } from './executors/deploy/schema.js'

// `createNodesV2` is the Nx plugin auto-inference hook. Re-exported
// here so `nx.json` → `"plugins": ["@camstack/nx-plugin"]` can pick
// it up without an explicit entry point.
export { createNodesV2 } from './plugin.js'
