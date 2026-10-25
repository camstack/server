/**
 * Lazy, cached loader for the node-av native module + its constants.
 *
 * Bundle discipline (identical to `addon-decoder-nodeav`): NEVER statically
 * `import` a value or `import type` a class from `'node-av'`. A value binding
 * drags node-av's high-level API — which pulls the native bindings + werift —
 * into the addon bundle, breaking the runner with "Cannot access 'require'
 * before initialization". The module is reached ONLY through a runtime
 * `await import('node-av')`; the type surface is a fully-erased
 * `typeof import('node-av')` query.
 *
 * The addon pre-loads this once at `onInitialize` (see `addon/index.ts`): the
 * `await` resolves the native binding and validates node-av is usable on this
 * node. After that the module refs are cached, so every session runtime is
 * constructed SYNCHRONOUSLY from `NodeAvRuntime` — there is no async gap between
 * "create session" and "runtime ready" in which a concurrent `closeSession`
 * could orphan an in-flight native context (the create-race leak class fixed in
 * the ffmpeg audio path, P5). Native access stays single-threaded via the sync
 * codec methods.
 */

// Type-only module queries — erased at build, drag nothing into the bundle.
type NodeAvModule = typeof import('node-av')
type NodeAvConstants = typeof import('node-av/constants')

/** The node-av value surface this addon uses, resolved once and shared. */
export interface NodeAvRuntime {
  readonly nav: NodeAvModule
  readonly consts: NodeAvConstants
}

let _runtime: NodeAvRuntime | null = null

/**
 * Load (or return the cached) node-av runtime. Rejects if the native binding
 * cannot be loaded on this node — the caller treats that as "node-av
 * unavailable" and declines to register the cap so the singleton falls back to
 * `audio-codec-ffmpeg`.
 */
export async function loadNodeAvRuntime(): Promise<NodeAvRuntime> {
  if (_runtime) return _runtime
  const [nav, consts] = await Promise.all([import('node-av'), import('node-av/constants')])
  _runtime = { nav, consts }
  return _runtime
}

/**
 * The already-loaded runtime, or `null` if `loadNodeAvRuntime` has not resolved
 * yet. Session runtimes read this synchronously — the addon guarantees it is
 * populated before any session is created.
 */
export function peekNodeAvRuntime(): NodeAvRuntime | null {
  return _runtime
}
