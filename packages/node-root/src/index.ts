/**
 * @camstack/node-root — the shared, zero-runtime-dep node-root boot core.
 *
 * PRIVATE workspace package: it is BUNDLED at build time into the hub's
 * `dist/server-root/index.js` (tsup) and into the agent's tsup output —
 * never published, never resolved from node_modules at runtime. Both node
 * starters and both update services are thin per-node adapters over these
 * modules, so the boot-plan / probation / rollback semantics can never
 * drift between the hub and the agent.
 *
 * Spec: docs/superpowers/specs/2026-07-12-runtime-updatable-node-packages-design.md
 */
export * from './dev-uploads.js'
export * from './root-package-spec.js'
export * from './root-state.js'
export * from './desktop-app-channel.js'
export * from './root-single-copy.js'
export * from './boot-plan.js'
export * from './semver-compare.js'
export * from './image-contract.js'
export * from './wrapper-identity.js'
export * from './workspace-detect.js'
export * from './starter-core.js'
export * from './root-update-service.js'
