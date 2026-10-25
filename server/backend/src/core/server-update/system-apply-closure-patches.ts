/**
 * `buildSystemApplyClosurePatches` — run the root package's OWN shipped patch
 * applier inside a staged closure, without going through npm.
 *
 * ## Why this exists
 *
 * `@camstack/server` applies its `closure-postinstall` patches (D478 — werift)
 * from its `postinstall`. npm 12 blocks a dependency's install scripts unless
 * the installing manifest allow-lists it, and the block is a WARNING, not an
 * error: the install succeeds, the patch silently does not land, and the only
 * thing that notices is `findUnappliedClosurePatches` refusing the swap.
 *
 * Measured 2026-09-13 on the Mac-mini agent, which had bootstrapped npm 12.0.1
 * while hub and agent-a still ran npm 11. That node sat two versions
 * behind with no other symptom, and the applier — run by hand in the very same
 * staging closure — reported `APPLIED werift@0.22.9` on three files. The code
 * was never wrong; it was never called.
 *
 * `CLOSURE_ALLOW_SCRIPTS` in `root-update-service.ts` un-blocks the lifecycle
 * again, and that is the right fix for `better-sqlite3` and `node-av`, which
 * genuinely need npm to fetch or build something. It is NOT the right fix for a
 * patch of ours: making our own patch depend on an npm policy is the dependency
 * D478 was written to remove. So this runs unconditionally and in addition.
 *
 * Safe to run twice: the applier is idempotent by construction — every hunk
 * recognises its own output, so an already-patched file is skipped rather than
 * patched again.
 *
 * ## Which Node
 *
 * `process.execPath` — the one already running. A packaged desktop ships a bare
 * bundled Node and has no `node` on PATH at all (the Mac agent's process runs
 * with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`), so resolving `node` by name would
 * ENOENT on exactly the host this was written for.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { IScopedLogger } from '@camstack/types'

const execFileAsync = promisify(execFile)

/** Matches `RootUpdateServiceOptions.applyClosurePatches`. */
export type ApplyClosurePatchesFn = (closureDir: string) => Promise<void>

/** Where the published root package keeps its applier, inside a closure. */
const APPLIER_REL = ['node_modules', '@camstack', 'server', 'scripts', 'closure-postinstall.mjs']

/** A patch pass must never be the slow part of an update. */
const APPLY_TIMEOUT_MS = 60_000

export function buildSystemApplyClosurePatches(logger: IScopedLogger): ApplyClosurePatchesFn {
  return async (closureDir) => {
    const applier = path.join(closureDir, ...APPLIER_REL)
    if (!fs.existsSync(applier)) {
      // A closure from before D478, or a root package that ships no patches.
      // Nothing to apply is not a failure — and the patch VALIDATOR, not this,
      // is what decides whether a missing patch matters.
      logger.debug('closure ships no patch applier — nothing to apply', {
        meta: { applier },
      })
      return
    }
    const { stdout, stderr } = await execFileAsync(process.execPath, [applier], {
      cwd: path.dirname(path.dirname(applier)),
      timeout: APPLY_TIMEOUT_MS,
    })
    // The applier names every file it touched and every one it refused. Those
    // lines are the only record that the patch pass happened at all, so they
    // are forwarded rather than swallowed.
    const output = `${stdout}${stderr}`.trim()
    if (output.length > 0) {
      logger.info('closure patches applied', { meta: { output } })
    }
  }
}
