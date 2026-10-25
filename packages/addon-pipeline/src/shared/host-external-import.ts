/**
 * Resolving a HOST-EXTERNAL package (`sharp`, `node-av`, …) from a process that
 * does NOT have the framework ESM resolver hook registered.
 *
 * ## The problem this exists for
 *
 * An addon bundle leaves the packages in `HOST_EXTERNAL_SPECIFIERS`
 * (`@camstack/system` → `kernel/host-externals.ts`) unbundled and expects the
 * HOST to provide them. What provides them is a module-customization hook
 * (`framework-resolver-hook.mjs`) that `registerFrameworkResolver` installs in
 * the **addon-runner process**, re-anchoring those bare specifiers at
 * `<frameworkDir>/node_modules`.
 *
 * A worker started with a plain `child_process.fork` — the session decode
 * worker (`session-decode/fork-decode-worker.ts`) is the one in this package —
 * does NOT inherit that hook. In it, `import('sharp')` and `import('node-av')`
 * throw `Cannot find package 'X' imported from /data/addons/@camstack/…`,
 * because the addon directory has no `node_modules` to walk up into.
 *
 * ## Why an explicit path and not the hook
 *
 * Registering the framework resolver in the child was considered and rejected:
 *
 *  - it would need the child to reach INTO another package's build output
 *    (`<frameworkDir>/node_modules/@camstack/system/dist/…/framework-resolver-hook.mjs`)
 *    plus an `--import` shim, i.e. a hard coupling to a layout nothing checks;
 *  - a registered hook makes **every** `import()` in that process re-enter the
 *    loader and block the main thread on `Atomics.wait` until the hooks worker
 *    answers — the exact cost `shared/lazy-sharp.ts` was written to remove from
 *    the frame path. Paying it per decode worker to load two modules is the
 *    wrong trade;
 *  - the explicit-path fallback is already the shipped answer for `node-av` in
 *    this same worker, and had been for months. A second mechanism for `sharp`
 *    would mean two ways to fail.
 *
 * So: try the bare specifier (works on the hub, where the fork inherits the
 * hook, and in dev, where workspace symlinks resolve), then resolve the package
 * explicitly out of the module roots an agent is known to lay out.
 *
 * ## The anchors, in order
 *
 *  - **DOCKER / single-copy node** — the framework overlay
 *    `CAMSTACK_FRAMEWORK_DIR` (`<frameworkDir>/node_modules/<pkg>`). The
 *    launcher points this at the ACTIVE closure in data-root mode and forked
 *    children inherit it (`server/backend/src/launcher.ts`).
 *  - **ELECTRON agent** — the app bundle around `CAMSTACK_BUNDLED_ADDONS_DIR`
 *    (`<resources>/node_modules/@camstack` since 2026-08-25, `<resources>/addons`
 *    before it): `<resources>/node_modules/<pkg>` and the `app.asar.unpacked`
 *    mirror. See {@link electronResourcesRoot} — the depth is NOT assumed.
 *  - **the process cwd** — always tried last, and it is NOT redundant:
 *    `CAMSTACK_FRAMEWORK_DIR` is only exported on some boots (the Docker
 *    entrypoint sets it in its fallback branch; the launcher only in data-root
 *    mode), while the launcher ALWAYS extends `NODE_PATH` with the framework and
 *    hub `node_modules`. A CJS-style resolution honours `NODE_PATH`; an ESM
 *    `import()` of a bare specifier does not. This is the same escape hatch
 *    `stream-broker/webrtc/session.ts` uses to find the framework's `werift`.
 *
 * An anchor that cannot resolve the specifier is skipped, so an empty result
 * leaves the bare specifier as the only path, exactly as before.
 *
 * Resolution goes through `createRequire(...).resolve(specifier)` rather than a
 * hardcoded relative entry (`dist/index.js`, …): that honours the package's own
 * `exports`/`main`, so it keeps working across a dependency's file-layout
 * changes, handles SUBPATH specifiers (`node-av/constants`) with no mapping
 * table, and consults `NODE_PATH`. It also verifies the file exists, which is
 * what the previous `fs.existsSync` check did by hand.
 */

import { createRequire } from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

/** A read-only view of `process.env` — injectable so the resolver is testable. */
export type HostExternalEnv = Readonly<Record<string, string | undefined>>

/**
 * Resolve `specifier` as if it were required from `anchorPath`, or `null` when
 * it is not there. Injectable so a spec can pin the candidate ORDER without a
 * filesystem.
 */
export type HostExternalResolver = (anchorPath: string, specifier: string) => string | null

/** Overrides for {@link hostExternalEntryUrls}. All default to the real thing. */
export interface HostExternalOptions {
  readonly env?: HostExternalEnv
  readonly resolve?: HostExternalResolver
  readonly cwd?: string
}

/**
 * The anchor filename resolution walks up from. It never has to EXIST —
 * `createRequire` only needs a path to anchor at — but naming it after camstack
 * keeps a stack trace readable if one ever escapes.
 */
const ANCHOR_FILE = '__camstack_host_external_anchor__.cjs'

/** Node error codes that mean "the module is not there", not "it failed to load". */
const RESOLUTION_ERROR_CODES: readonly string[] = [
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_UNSUPPORTED_DIR_IMPORT',
]

/** `err.code` when the error carries a string one. No cast: `in` narrows. */
function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  if (!('code' in err)) return null
  const code: unknown = err.code
  return typeof code === 'string' ? code : null
}

/**
 * True when `err` says the module could not be FOUND (as opposed to found and
 * failed to load — a broken native binary, a throwing top level).
 *
 * The distinction is load-bearing for callers that memoize failure: a
 * resolution failure is deterministic for the life of the process (the env and
 * the framework layout do not change under a running worker), so retrying it
 * per frame can only re-pay the loader round-trip and re-log. A LOAD failure
 * can plausibly be a deploy blip and stays retryable.
 *
 * The message check is a belt for the same braces: Node has moved these codes
 * before, and a miss here degrades to "retry forever", which is the bug.
 */
export function isModuleResolutionError(err: unknown): boolean {
  const code = errorCode(err)
  if (code !== null && RESOLUTION_ERROR_CODES.includes(code)) return true
  if (!(err instanceof Error)) return false
  return err.message.includes('Cannot find package') || err.message.includes('Cannot find module')
}

/**
 * Path segments that are containers on the way to a package dir, never the
 * Electron `Resources` dir itself. Walking past them is what makes the anchor
 * derivation independent of WHICH dir the shell chose to seed addons from.
 */
const SEED_CONTAINER_SEGMENTS: readonly string[] = ['@camstack', 'node_modules', 'addons']

/**
 * The Electron `Contents/Resources` dir, derived from `CAMSTACK_BUNDLED_ADDONS_DIR`.
 *
 * That variable names the dir the launcher SEEDS addons from, and its shape has
 * moved: it was `<resources>/addons` (a second, hand-copied tree) and is now
 * `<resources>/node_modules/@camstack`, the closure's own scope dir — one copy
 * (D45). What this function needs is neither: it needs the sibling
 * `<resources>/node_modules`, where the hoisted `sharp` / `node-av` actually
 * live. A plain `path.dirname` answered the first shape and would have silently
 * answered `<resources>/node_modules/node_modules` for the second, losing both
 * packages in every forked decode worker on a desktop agent. So: climb past the
 * container segments instead of assuming a depth.
 */
export function electronResourcesRoot(bundledAddonsDir: string): string {
  let dir = path.resolve(bundledAddonsDir)
  while (SEED_CONTAINER_SEGMENTS.includes(path.basename(dir))) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
}

/**
 * The files a resolution is anchored at, in the order they are tried. Each is a
 * path INSIDE a candidate `node_modules` (so `<dir>/node_modules/<pkg>` is on
 * the walk), except the cwd anchor, which walks up from the cwd itself.
 *
 * The anchor files never have to exist — `createRequire` only needs a path.
 */
export function hostExternalAnchors(env: HostExternalEnv, cwd: string): readonly string[] {
  const anchors: string[] = []
  const frameworkDir = env['CAMSTACK_FRAMEWORK_DIR']
  if (frameworkDir !== undefined && frameworkDir.length > 0) {
    anchors.push(path.join(frameworkDir, 'node_modules', ANCHOR_FILE))
  }
  const bundledAddons = env['CAMSTACK_BUNDLED_ADDONS_DIR']
  if (bundledAddons !== undefined && bundledAddons.length > 0) {
    const resourcesRoot = electronResourcesRoot(bundledAddons)
    anchors.push(path.join(resourcesRoot, 'node_modules', ANCHOR_FILE))
    anchors.push(path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', ANCHOR_FILE))
  }
  anchors.push(path.join(cwd, ANCHOR_FILE))
  return anchors
}

/** `createRequire(anchor).resolve(specifier)`, or `null` when it is not there. */
function resolveFromAnchor(anchorPath: string, specifier: string): string | null {
  try {
    return createRequire(anchorPath).resolve(specifier)
  } catch {
    return null
  }
}

/**
 * Importable `file:` URLs for `specifier`, in the order a caller should try them
 * after the bare specifier has already failed. Deduplicated (two anchors
 * routinely resolve to the SAME file — a NODE_PATH hit, or a symlink), and empty
 * when nothing resolves it, which leaves the bare specifier the only path.
 */
export function hostExternalEntryUrls(
  specifier: string,
  options: HostExternalOptions = {},
): readonly string[] {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const resolveEntry = options.resolve ?? resolveFromAnchor
  const urls: string[] = []
  for (const anchor of hostExternalAnchors(env, cwd)) {
    const entry = resolveEntry(anchor, specifier)
    if (entry === null || entry.length === 0) continue
    const url = pathToFileURL(entry).href
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}
