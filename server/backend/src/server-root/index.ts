/**
 * Hub server-root barrel — re-exports the SHARED zero-dep node-root boot
 * core (`@dominevo/node-root`, a private workspace package) plus the
 * hub-bound convenience wrappers (`@dominevo/server` + `dist/launcher.js`).
 *
 * BUILD NOTE: `@dominevo/node-root` is private and never published, so it
 * must not survive as a runtime `require` in the published `@dominevo/server`
 * dist. The server build therefore runs tsup AFTER tsc and OVERWRITES
 * `dist/server-root/index.js` with a self-contained bundle (see
 * `server/backend/tsup.config.ts`). Every hub consumer — the zero-dep
 * starter included — imports this barrel RELATIVELY, so at runtime the
 * bundled sibling file is all that's needed.
 *
 * Spec: docs/superpowers/specs/2026-07-12-runtime-updatable-node-packages-design.md
 */
import { HUB_ROOT_SPEC, rootEntryPath, rootPackageDir } from '@dominevo/node-root'

export * from '@dominevo/node-root'

/** The hub's root package name (`@dominevo/server`). */
export const SERVER_ROOT_PACKAGE_NAME = HUB_ROOT_SPEC.packageName

/** `versions/<v>/node_modules/@dominevo/server` — hub-bound wrapper. */
export function serverPackageDir(versionDirPath: string): string {
  return rootPackageDir(versionDirPath, HUB_ROOT_SPEC)
}

/** `.../@dominevo/server/dist/launcher.js` — hub-bound wrapper. */
export function serverEntryPath(versionDirPath: string): string {
  return rootEntryPath(versionDirPath, HUB_ROOT_SPEC)
}
