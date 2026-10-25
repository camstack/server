import type { ICamstackAddon } from '@camstack/types'

type AddonConstructor = new () => ICamstackAddon

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve the addon class from a dynamically imported module.
 *
 * Two compilation patterns to handle:
 *   1. ESM with explicit `export default class …` — `mod.default` is the class.
 *   2. CJS via tsup that emits only named exports (no `module.exports = …`)
 *      — `mod.default` is undefined; we must pick the right named export.
 *
 * The CJS path is the trap: an addon bundle can also re-export device
 * classes (e.g. `ReolinkCamera` extends `BaseDevice`) and helper
 * functions. Picking `Object.keys(mod)[0]` is bundler-order-dependent —
 * the first named export today is `ReolinkCamera`, whose `new` requires
 * a `DeviceContext` and crashes on `new MyClass()`.
 *
 * The contract is: the addon class extends `BaseAddon`, which has an
 * `initialize` method on its prototype. Device classes (`BaseDevice`)
 * do not. We probe for that method to disambiguate.
 */
function isAddonConstructor(fn: unknown): fn is AddonConstructor {
  if (typeof fn !== 'function') return false
  const proto = (fn as { prototype?: unknown }).prototype
  if (!isRecord(proto)) return false
  return typeof proto['initialize'] === 'function'
}

export function resolveAddonClass(mod: Record<string, unknown>): AddonConstructor | undefined {
  // 1. Explicit default export — preferred.
  let candidate: unknown = mod['default']

  // Unwrap double-nested default (CJS interop with tsup).
  if (isRecord(candidate) && 'default' in candidate) {
    candidate = candidate['default']
  }
  if (isAddonConstructor(candidate)) return candidate

  // CJS module imported via ESM: default slot is an object holding the
  // named exports. Scan its values for the first addon-shaped function.
  if (isRecord(candidate)) {
    const fn = Object.values(candidate).find(isAddonConstructor)
    if (fn) return fn
  }

  // 2. No usable default — scan named exports of the top-level module.
  //    Crucially: filter on the addon shape (prototype.initialize), NOT
  //    the first function. Otherwise a bundle that exports a device class
  //    before its addon class (alphabetical / insertion order) blows up
  //    in BaseDevice's constructor when instantiated with no args.
  const namedAddon = Object.values(mod).find(isAddonConstructor)
  if (namedAddon) return namedAddon

  return undefined
}
