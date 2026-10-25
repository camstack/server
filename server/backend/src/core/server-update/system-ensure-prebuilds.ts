/**
 * `buildSystemEnsureNativePrebuilds` — the `@camstack/system`-backed
 * `ensureNativePrebuilds` adapter the shared `RootUpdateService` uses as its
 * post-install native-prebuild ENSURE step (`RootUpdateServiceOptions.
 * ensureNativePrebuilds`).
 *
 * The zero-dep `@camstack/node-root` layer cannot fetch npm packages itself, so
 * the fetcher lives in `@camstack/system` (next to `runNpm` / the addon
 * native-deps installer) and is injected here at the hub/agent construction
 * sites — exactly like `buildSystemExecNpm`. Harmless on docker (the prebuilds
 * already landed → a no-op); it only acts on a toolchain-less packaged desktop
 * whose `npm install` left `better-sqlite3` source-only.
 */
import { ensureNativePrebuilds } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'

/** Matches `RootUpdateServiceOptions.ensureNativePrebuilds`. */
export type EnsureNativePrebuildsFn = (closureDir: string) => Promise<void>

export function buildSystemEnsureNativePrebuilds(logger: IScopedLogger): EnsureNativePrebuildsFn {
  return async (closureDir) => {
    await ensureNativePrebuilds(closureDir, { logger })
  }
}
