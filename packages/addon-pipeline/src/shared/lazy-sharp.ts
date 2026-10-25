/**
 * lazy-sharp — resolve `sharp` ONCE, not once per frame, and give up ONCE when
 * it cannot be resolved at all.
 *
 * ## What this fixes (2026-08-02)
 *
 * `await import('sharp')` sat directly in the frame path, in a spot whose own
 * comment reads "This is the production hot path (camera frames from broker)",
 * and in six other places along the same path. At ~13 fps per camera across the
 * fleet that is thousands of dynamic imports a minute.
 *
 * Node caches the MODULE after the first import, so this looks free. It is not:
 * the addon runner registers module-customization hooks (the framework
 * resolver), and with hooks registered every `import()` re-enters the loader and
 * resolves the specifier through the hooks worker — **synchronously**. A CPU
 * profile of the live detection runner caught it exactly:
 *
 *     makeSyncRequest@hooks:631
 *     resolveSync@hooks:860
 *     #resolveAndMaybeBlockOnLoaderThread@loader:715
 *     …
 *     import@loader:626
 *     runPipeline@index.js:5565
 *
 * `#resolveAndMaybeBlockOnLoaderThread` is the name of the problem:
 * `makeSyncRequest` blocks the MAIN THREAD on `Atomics.wait` until the hooks
 * worker answers. That is a synchronous block on the frame path, which is the
 * shape the 22-88s event-loop freezes had.
 *
 * ## What it fixes a second time (2026-08-14)
 *
 * A memo that CLEARS on failure re-pays that entire cost on every call once the
 * module genuinely is not there. The subject-tile tier hit exactly that: in the
 * decode worker (a plain `child_process.fork`, no resolver hook) `import('sharp')`
 * cannot resolve, and because the memo was dropped on failure, every subject of
 * every frame re-entered the loader and logged a WARN — 3 800 WARN/min
 * cluster-wide, with a synchronous loader round-trip on the frame path behind
 * each one, and not one tile ever cut.
 *
 * So this module now does two more things:
 *
 *  1. **Falls back to an explicit path.** Same mechanism `node-av` has used in
 *     the same worker for months, extracted into
 *     `shared/host-external-import.ts` — read its docblock for the layouts and
 *     for why the framework resolver is NOT registered in the child instead.
 *  2. **Distinguishes the two failure kinds.**
 *     - **Resolution** failure (nothing, anywhere, resolves `sharp`): the answer
 *       cannot change while this process lives, so it is memoized as a sticky
 *       {@link SharpUnavailableError}. Later calls reject IMMEDIATELY, with no
 *       loader re-entry, and exactly ONE warning is emitted for the process
 *       naming every candidate tried and the cause.
 *     - **Load** failure (found, but the native binary or the module body threw):
 *       the memo is cleared, so a later call retries. A partially-installed
 *       native dep during a deploy must not poison the encoder for the whole
 *       process lifetime — that would turn a blip into a camera that never
 *       produces media again. This is the original behaviour, kept on purpose,
 *       and it is safe to keep only because it is now the NARROW case.
 *
 * ## Why a memo and not a static import
 *
 * `sharp` is a heavy native module. The dynamic import was deliberate — nodes
 * that never encode a frame should not pay to load it, and a node whose native
 * build is missing must fail at first use rather than at boot. Both properties
 * survive: the module is still loaded on FIRST use, and a failure still surfaces
 * at that call. Only the repeat resolutions are removed.
 *
 * The promise itself is cached (not just the resolved value), so N concurrent
 * first-callers share one import instead of racing into N.
 */

import { hostExternalEntryUrls, isModuleResolutionError } from './host-external-import.js'

/**
 * `sharp`'s own factory type. Taken from the module rather than hand-written:
 * a structural stand-in looked tidy and immediately lost `.grayscale()` and
 * `toBuffer({ resolveWithObject: true })`, i.e. it would have forced call sites
 * to cast — trading a real type for a cast, which this codebase forbids.
 */
export type SharpFactory = typeof import('sharp')['default']

/** The bare specifier. Also the first entry of a failure's candidate list. */
const SHARP_SPECIFIER = 'sharp'

/** The shape both the bare import and a `file:` URL import produce. */
export interface SharpModuleShape {
  readonly default: SharpFactory
}

/** Imports one specifier (bare or `file:` URL). Injectable for tests. */
export type SharpModuleImporter = (specifier: string) => Promise<SharpModuleShape>

/** Where a one-off diagnostic goes. The worker routes it to its scoped logger. */
export type SharpWarnSink = (message: string) => void

/** Everything {@link createSharpLoader} touches outside itself. */
export interface SharpLoaderDeps {
  readonly importModule?: SharpModuleImporter
  readonly fallbackUrls?: () => readonly string[]
  readonly warn?: SharpWarnSink
}

/** A `sharp` factory that is resolved at most once, with sticky unavailability. */
export interface SharpLoader {
  load(): Promise<SharpFactory>
  /** Drops BOTH memos (value and sticky failure). Test / recovery seam. */
  reset(): void
}

/**
 * `sharp` cannot be resolved in this process, and nothing about that can change
 * while it runs. Carries the candidates tried so the log answers "where did you
 * look" without a second round of diagnosis.
 */
export class SharpUnavailableError extends Error {
  readonly attempts: readonly string[]

  constructor(attempts: readonly string[], cause: unknown) {
    super(
      `sharp could not be resolved in this process — tried ${attempts.join(', ')}; ` +
        `cause: ${describeError(cause)}`,
      { cause },
    )
    this.name = 'SharpUnavailableError'
    this.attempts = attempts
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The bare specifier stays a LITERAL `import('sharp')` so the bundler keeps
 * treating it as the declared external it is; only the fallback candidates go
 * through a variable specifier (typed `any` by TS, so the declared return type
 * applies without a cast — the same shape `importNodeAv` uses).
 */
async function importSharpModule(specifier: string): Promise<SharpModuleShape> {
  if (specifier === SHARP_SPECIFIER) return import('sharp')
  const mod = await import(specifier)
  return mod
}

/**
 * Build a loader. Exported for tests; production uses the module-level
 * {@link getSharp}, which is one of these.
 */
export function createSharpLoader(deps: SharpLoaderDeps = {}): SharpLoader {
  const importModule = deps.importModule ?? importSharpModule
  const fallbackUrls =
    deps.fallbackUrls ?? ((): readonly string[] => hostExternalEntryUrls(SHARP_SPECIFIER))
  const warn = deps.warn

  let pending: Promise<SharpFactory> | null = null
  let unavailable: SharpUnavailableError | null = null
  let warned = false

  /** Bare first, then each fallback candidate, in order. */
  const attempt = async (): Promise<SharpFactory> => {
    const attempts: string[] = [SHARP_SPECIFIER]
    let lastError: unknown
    try {
      const mod = await importModule(SHARP_SPECIFIER)
      return mod.default
    } catch (bareError) {
      // Found-but-broken is not our problem to memoize: rethrow and let a later
      // call try again.
      if (!isModuleResolutionError(bareError)) {
        pending = null
        throw bareError
      }
      lastError = bareError
    }
    for (const url of fallbackUrls()) {
      attempts.push(url)
      try {
        const mod = await importModule(url)
        return mod.default
      } catch (candidateError) {
        if (!isModuleResolutionError(candidateError)) {
          pending = null
          throw candidateError
        }
        lastError = candidateError
      }
    }
    const failure = new SharpUnavailableError(attempts, lastError)
    // Sticky: `load()` short-circuits on `unavailable` from here on, so no later
    // call re-enters the module loader. `pending` is dropped so the sticky check
    // is the ONLY path that can answer.
    unavailable = failure
    pending = null
    if (!warned) {
      warned = true
      if (warn) warn(failure.message)
      else process.stderr.write(`${failure.message}\n`)
    }
    throw failure
  }

  return {
    load: (): Promise<SharpFactory> => {
      if (unavailable !== null) return Promise.reject(unavailable)
      if (pending === null) pending = attempt()
      return pending
    },
    reset: (): void => {
      pending = null
      unavailable = null
      warned = false
    },
  }
}

/** Where the process-wide loader's single diagnostic goes. */
let warnSink: SharpWarnSink | null = null

/**
 * Route the one-off "sharp is unavailable" diagnostic somewhere it will be seen.
 * Without a sink it goes to stderr, which the decode worker's parent inherits
 * but does NOT forward to the scoped logger — so the worker installs one at
 * boot (`decode-worker-child.ts`) to get the line into `addons.getLogs` with its
 * `[dev:<id>]` prefix.
 */
export function setSharpWarnSink(sink: SharpWarnSink): void {
  warnSink = sink
}

const defaultLoader = createSharpLoader({
  // Indirected through the mutable sink: this loader is built at module load,
  // before any process has had a chance to say where its logs go.
  warn: (message: string): void => {
    if (warnSink) warnSink(message)
    else process.stderr.write(`${message}\n`)
  },
})

/**
 * The `sharp` factory, resolved once per process.
 *
 * Rejects with {@link SharpUnavailableError} — immediately, and without touching
 * the module loader — once resolution has been proven impossible here.
 */
export function getSharp(): Promise<SharpFactory> {
  return defaultLoader.load()
}
