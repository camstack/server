/**
 * Native-prebuild staging helpers for the DMG build (`stage-deps.mjs`).
 *
 * PURE + zero-dep (node:fs/node:path only) so the missing-prebuild detection and
 * the addon→native mapping are unit-testable without a real npm install.
 *
 * Problem this addresses (fresh CamStack.app first-boot FATAL, 2026-07-21): the
 * `npm install @camstack/server` closure HOISTS the native modules
 * (`better-sqlite3`, `sharp`, `node-av` + their `@img`/`@seydx` platform
 * siblings) to the TOP-LEVEL `node_modules`, so an addon's own subtree carries
 * none of them. At runtime the addon-installer copies that subtree into
 * `data/addons/@camstack/<addon>` and `npm install`s the addon's deps; on a
 * toolchain-less Mac that leaves `better-sqlite3` source-only, so the runner
 * cannot load its `.node`. Planting each referenced native (WITH its
 * bundled-Node `.node`) into the addon copy's own `node_modules` makes the
 * subtree self-contained; the runtime installer then propagates it verbatim.
 *
 * ── Which copies get planted, and the bug that answer had (2026-08-25) ──────
 * Until now the list came from the `extraResources` entries whose `to` started
 * with `addons/` — the second, hand-copied `Resources/addons/<addon>` tree the
 * app used to ship beside the closure. That tree was the WRONG target twice
 * over. Measured on `release/mac-arm64/…/Resources`: electron-builder dropped
 * `node_modules` on every per-package `extraResources` entry, so not one `.node`
 * reached `Resources/addons/**` although `.deps/node_modules/@camstack/
 * addon-pipeline/node_modules` had carried them since before the build ran. The
 * planting was verified in `.deps` and lost in transit; `copyBundledNativeModules`
 * and `ensureAddonNativePrebuilds({ bundledSourceDir })` were no-ops against the
 * copy the installer actually seeded from.
 *
 * The second tree is gone. The seed source is the closure's own scope dir,
 * `Resources/node_modules/@camstack`, which electron-builder copies WITH the
 * package `node_modules`. So the dirs to plant into are every `@camstack`
 * package in the staged closure — see {@link bundledAddonSourceDirs}. That is
 * also strictly wider than the old six: an addon the closure carries but the
 * `extraResources` list forgot (`addon-decoder-nodeav`, `addon-auth`,
 * `addon-notifiers`) is now both seeded locally and verified.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Native package → platform SIBLING scope dirs that hold its `.node`. Empty for
 * the traditional (non-N-API) `better-sqlite3` (binary in its own dir).
 */
export const NATIVE_SIBLING_SCOPES = Object.freeze({
  'better-sqlite3': [],
  sharp: ['@img'],
  'node-av': ['@seydx'],
})

/**
 * Where each native's `.node` may live, relative to an addon copy's
 * `node_modules` — the package dir AND its platform sibling scope(s). Mirrors
 * `findMissingNativePrebuilds` in `@camstack/node-root`.
 */
export const NATIVE_SEARCH_DIRS = Object.freeze({
  'better-sqlite3': ['better-sqlite3'],
  sharp: ['sharp', '@img'],
  'node-av': ['node-av', '@seydx'],
})

/** Bounded recursive scan for ANY `*.node` under `dir`. */
export function hasDotNode(dir, maxDepth = 6) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.node')) return true
  }
  if (maxDepth <= 0) return false
  for (const entry of entries) {
    if (entry.isDirectory() && hasDotNode(path.join(dir, entry.name), maxDepth - 1)) return true
  }
  return false
}

/**
 * Every `@camstack/*` package dir inside a staged closure's `node_modules` —
 * i.e. every dir the packaged app's `CAMSTACK_BUNDLED_ADDONS_DIR` can seed from,
 * because `AddonInstaller.findLocalPackage` joins the SHORT name onto that dir
 * and an npm scope dir is laid out exactly that way.
 *
 * Sorted, so the build log and the verification order are stable. A dir without
 * a `package.json` (`.bin`, a stray) is not a package and is skipped. PURE.
 */
export function bundledAddonSourceDirs(stageModules) {
  const scopeDir = path.join(stageModules, '@camstack')
  let entries
  try {
    entries = fs.readdirSync(scopeDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(scopeDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .sort()
}

/**
 * The native packages an addon references (direct `dependencies` /
 * `optionalDependencies`). Only names in `NATIVE_SIBLING_SCOPES` are returned.
 */
export function referencedNativePackages(pkgJson) {
  const deps = {
    ...(pkgJson && pkgJson.dependencies ? pkgJson.dependencies : {}),
    ...(pkgJson && pkgJson.optionalDependencies ? pkgJson.optionalDependencies : {}),
  }
  return Object.keys(NATIVE_SIBLING_SCOPES).filter((name) => name in deps)
}

/**
 * Given an addon copy dir + the natives it references, return those whose
 * `.node` is NOT present under the copy's `node_modules`. Empty ⇒ self-contained.
 * PURE — the verification predicate the build fails on.
 */
export function addonMissingNatives(addonCopyDir, natives) {
  const nm = path.join(addonCopyDir, 'node_modules')
  return natives.filter(
    (name) =>
      !(NATIVE_SEARCH_DIRS[name] ?? [name]).some((rel) => hasDotNode(path.join(nm, rel), 6)),
  )
}

/**
 * Copy a hoisted native (+ its platform sibling scope dirs carrying a `.node`)
 * from the closure's top-level `node_modules` (`stageModules`) into an addon
 * copy's own `node_modules`. Returns the module paths copied (for logging).
 */
export function stageNativeIntoAddon(stageModules, addonCopyDir, nativeName) {
  const destNm = path.join(addonCopyDir, 'node_modules')
  const copied = []

  const copyModule = (src, dst) => {
    if (!fs.existsSync(src)) return
    if (hasDotNode(dst, 6)) return // already present — don't clobber
    fs.rmSync(dst, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.cpSync(src, dst, { recursive: true, dereference: true })
    copied.push(dst)
  }

  copyModule(path.join(stageModules, nativeName), path.join(destNm, nativeName))
  for (const scope of NATIVE_SIBLING_SCOPES[nativeName] ?? []) {
    const scopeSrc = path.join(stageModules, scope)
    let siblings
    try {
      siblings = fs.readdirSync(scopeSrc)
    } catch {
      continue
    }
    for (const sibling of siblings) {
      copyModule(path.join(scopeSrc, sibling), path.join(destNm, scope, sibling))
    }
  }
  return copied
}
