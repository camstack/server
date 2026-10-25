#!/usr/bin/env node
/**
 * `@camstack/server`'s `postinstall` — apply the `closure-postinstall` patches
 * to the framework closure this package was just installed into. (D478)
 *
 * ## Why a lifecycle script and not a bundler
 *
 * A patch under `patches/` reaches production only if the patched package is
 * BUNDLED at build time. `moleculer` is (into `@camstack/system/dist`), so its
 * patch travels inside a published tarball and needs nothing here. `werift` is
 * not, on purpose: three addons resolve it at runtime from the closure so the
 * installer's dedupe (D343) links them all at ONE 5.3 MB copy, and that copy
 * arrives from npm unpatched. Production ran it unpatched from the day the
 * patch was written until 2026-09-12.
 *
 * The closure is an `npm install` into a staging dir, so this package's own
 * `postinstall` is the natural place to do it — it is the one place that
 * (a) runs inside the closure, (b) runs with the NEW release's patch files,
 * and (c) needs no new dependency, no diff library and no change to the update
 * service. Every node gets it identically — hub, Docker agent, Electron agent
 * — because all three stage the closure through the same `RootUpdateService`.
 *
 * ## Failure policy, deliberately split in two
 *
 * This script is BEST-EFFORT: it exits 0 on anything it cannot do, including a
 * missing patch payload (the workspace dev tree, where `patch-package` already
 * did the work and `dist/` may not exist yet) and an `ignore-scripts` npmrc it
 * cannot see from inside. It must never be the reason an install fails, and it
 * must never leave a package half-patched — every hunk is applied to an
 * in-memory copy and the file is written once, or not at all.
 *
 * ## It is no longer the ONLY place, and must not be (D484)
 *
 * "the install passes no `--ignore-scripts`" was true and was the wrong
 * question. npm 12 blocks a dependency's install scripts WITHOUT the flag, so
 * on the Mac-mini agent this script was simply never called and the closure
 * came out unpatched with exit 0. `stageClosure` therefore also invokes this
 * applier directly, and the idempotence below is what makes running twice
 * harmless rather than a double patch.
 *
 * The FAIL-CLOSED half lives elsewhere, in `@camstack/node-root`'s
 * `findUnappliedClosurePatches`, which refuses to swap into a closure whose
 * markers are absent. Silence here is therefore never silence overall: either
 * the patch landed, or the update visibly does not apply. A best-effort applier
 * plus a fail-closed validator is the only arrangement where a skipped patch
 * cannot look like a working one.
 *
 * ## Idempotence
 *
 * npm may run this more than once, and the repo root's `patch-package` already
 * applies the same patches to the dev tree. Every hunk therefore recognises its
 * own output: `before` present exactly once ⇒ apply; `before` absent and
 * `after` present exactly once ⇒ already applied, skip. Anything else refuses
 * that FILE (never a partial write) and the validator turns it into a refused
 * update.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Where the build step (`copy-closure-patches.mjs`) puts the shipped payload. */
const PAYLOAD_DIRS = [
  // `scripts/` and `dist/` are siblings inside the package in BOTH layouts —
  // the published tarball and a workspace checkout with a built dist.
  path.resolve(HERE, '..', 'dist', 'closure-patches'),
]

const log = (msg) => process.stdout.write(`[closure-patches] ${msg}\n`)

function findPayloadDir() {
  for (const dir of PAYLOAD_DIRS) {
    if (fs.existsSync(path.join(dir, 'patch-reach.json'))) return dir
  }
  return null
}

/**
 * The `node_modules` the closure hoisted `werift` into. This script runs from
 * `<closure>/node_modules/@camstack/server/scripts`, so the closure's own
 * `node_modules` is three levels up — and a nested one (npm chose not to hoist)
 * is checked first, because that is the copy this package would resolve.
 */
function moduleRootsFor(pkg) {
  const own = path.resolve(HERE, '..', 'node_modules')
  const closure = path.resolve(HERE, '..', '..', '..')
  // `closure` is only a module root in the PUBLISHED layout
  // (`<closure>/node_modules/@camstack/server/scripts` → `<closure>/node_modules`).
  // From a workspace checkout the same walk lands on the repo root, which is
  // not one — the basename check is what keeps this script inert in the dev
  // tree instead of hunting for `<repo>/werift`.
  const roots = [own, ...(path.basename(closure) === 'node_modules' ? [closure] : [])]
  return roots.filter((root) => {
    try {
      return fs.statSync(path.join(root, pkg)).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * Parse a `patch-package` unified diff into `{ file, before, after }` hunks.
 *
 * Line NUMBERS are ignored on purpose. A hunk is identified by its content —
 * context plus removed lines — and applied only when that text occurs exactly
 * once in the file. That is stricter than a positional apply (a hunk whose
 * context appears twice refuses rather than guessing) and it survives an
 * upstream file that shifted by a line, which a positional apply would not.
 */
function parsePatch(text, pkg) {
  const hunks = []
  let file = null
  let before = null
  let after = null
  const flush = () => {
    if (file !== null && before !== null && before.length > 0) {
      hunks.push({ file, before: before.join('\n'), after: after.join('\n') })
    }
    before = null
    after = null
  }
  const prefix = `node_modules/${pkg}/`
  // A patch file ends with a newline, so `split` yields one trailing '' that is
  // NOT a blank context line. Dropping it matters: the branch below treats a
  // bare empty line as context (git can emit a blank context line with its
  // leading space stripped), and letting the file's own terminator through
  // would append a phantom newline requirement to the last hunk.
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      flush()
      file = null
      continue
    }
    if (raw.startsWith('+++ ')) {
      const spec = raw.slice(4).trim().replace(/^b\//, '')
      file = spec.startsWith(prefix) ? spec.slice(prefix.length) : null
      continue
    }
    if (raw.startsWith('@@')) {
      flush()
      before = []
      after = []
      continue
    }
    if (before === null || after === null) continue
    if (raw.startsWith('+')) {
      after.push(raw.slice(1))
    } else if (raw.startsWith('-')) {
      before.push(raw.slice(1))
    } else if (raw.startsWith(' ')) {
      before.push(raw.slice(1))
      after.push(raw.slice(1))
    } else if (raw === '') {
      // A context line for a blank source line — patch-package emits it bare.
      before.push('')
      after.push('')
    } else {
      // `\ No newline at end of file` and anything else: not content.
      continue
    }
  }
  flush()
  return hunks
}

function countOf(haystack, needle) {
  if (needle.length === 0) return 0
  let n = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    n += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return n
}

/** Apply every hunk for one file, in memory. Returns the new text, or null. */
function applyHunks(original, hunks) {
  let text = original
  let changed = false
  for (const hunk of hunks) {
    const hits = countOf(text, hunk.before)
    if (hits === 1) {
      text = text.replace(hunk.before, hunk.after)
      changed = true
      continue
    }
    if (hits === 0 && countOf(text, hunk.after) >= 1) continue // already applied
    return { error: `hunk matched ${hits} times (expected 1) and its result is absent` }
  }
  return { text, changed }
}

function applyPatchFile(payloadDir, entry) {
  const patchPath = path.join(payloadDir, entry.patch)
  let diff
  try {
    diff = fs.readFileSync(patchPath, 'utf-8')
  } catch {
    log(`SKIP ${entry.patch} — payload missing`)
    return
  }
  const roots = moduleRootsFor(entry.package)
  if (roots.length === 0) {
    log(`SKIP ${entry.package} — not installed in this closure`)
    return
  }
  const hunks = parsePatch(diff, entry.package)
  const byFile = new Map()
  for (const hunk of hunks) {
    if (hunk.file === null) continue
    const list = byFile.get(hunk.file) ?? []
    list.push(hunk)
    byFile.set(hunk.file, list)
  }
  for (const root of roots) {
    const pkgDir = path.join(root, entry.package)
    let installed = null
    try {
      installed = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')).version
    } catch {
      /* unreadable — reported below */
    }
    if (installed !== entry.version) {
      // Never patch a version the diff was not taken from. The validator turns
      // this into a refused update rather than a silently-unpatched closure.
      log(`REFUSE ${entry.package}@${String(installed)} in ${root} — patch is for ${entry.version}`)
      continue
    }
    for (const [rel, fileHunks] of byFile) {
      const target = path.join(pkgDir, rel)
      let original
      try {
        original = fs.readFileSync(target, 'utf-8')
      } catch {
        log(`REFUSE ${entry.package} ${rel} — file absent`)
        continue
      }
      const result = applyHunks(original, fileHunks)
      if (result.error !== undefined) {
        log(`REFUSE ${entry.package} ${rel} — ${result.error}`)
        continue
      }
      if (!result.changed) {
        log(`OK ${entry.package} ${rel} — already applied`)
        continue
      }
      fs.writeFileSync(target, result.text)
      log(`APPLIED ${entry.package}@${entry.version} ${rel} (${fileHunks.length} hunks)`)
    }
  }
}

function main() {
  const payloadDir = findPayloadDir()
  if (payloadDir === null) {
    // The workspace dev tree: `patch-package` at the repo root owns this, and
    // `dist/` may not be built yet. Not an error.
    return
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(payloadDir, 'patch-reach.json'), 'utf-8'))
  } catch (err) {
    log(`SKIP — manifest unreadable: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const entries = Array.isArray(manifest.patches) ? manifest.patches : []
  for (const entry of entries) {
    if (entry?.reach !== 'closure-postinstall') continue
    try {
      applyPatchFile(payloadDir, entry)
    } catch (err) {
      log(`SKIP ${entry.patch} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

main()
