import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'

/**
 * Inputs for {@link applyDeployedBundle}.
 *
 * `extract` is injected (rather than hard-wiring `tar`) so the swap logic is
 * unit-testable without a real tarball and so the caller controls the extractor
 * (the `$agent.deploy` handler wires the async `execFile tar --strip-components=1`
 * it already uses).
 */
export interface ApplyDeployedBundleInput {
  /** Directory holding installed addon package dirs (`<addonsDir>/<addonId>`). */
  readonly addonsDir: string
  /** On-disk dir name for this package (the `$agent.deploy` `addonId` param). */
  readonly addonId: string
  /** The `.tgz` bytes to extract. */
  readonly bundle: Buffer
  /** Extract `tgz` into `destDir` (stripping the npm `package/` prefix). */
  readonly extract: (tgz: Buffer, destDir: string) => Promise<void>
  readonly logger: IScopedLogger
}

/** Recursively remove a path, ignoring a missing target. */
function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true })
}

/**
 * Move `from` → `to` atomically when on the same filesystem; fall back to a
 * recursive copy + remove on a cross-device boundary (`EXDEV`). The agent's
 * `/data` addonsDir is frequently a different filesystem from the OS temp dir,
 * so a bare `renameSync` would throw `EXDEV` — the same fallback
 * `AddonInstaller.applyUpdateFromStaged` uses.
 */
function moveDir(from: string, to: string): void {
  try {
    fs.renameSync(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EXDEV') {
      fs.cpSync(from, to, { recursive: true })
      rmrf(from)
    } else {
      throw err
    }
  }
}

/**
 * Atomically install a deployed addon bundle into `<addonsDir>/<addonId>`.
 *
 * Unlike the old `$agent.deploy` body (`rm` the live dir, THEN untar into it),
 * this never leaves the live dir missing: extraction happens in a sibling temp
 * dir first, the live dir is swapped in by rename, and any failure restores the
 * previous copy. A killed/timed-out extract (the non-atomic-deploy hazard that
 * a contaminated propagation test hit) leaves the old version fully intact.
 *
 * No `AddonInstaller` manifest dependency — works for any deployed addon,
 * including ones never tracked in the agent's install manifest.
 *
 * @returns the live addon directory path (`<addonsDir>/<addonId>`).
 */
export async function applyDeployedBundle(
  input: ApplyDeployedBundleInput,
): Promise<{ addonDir: string }> {
  const { addonsDir, addonId, bundle, extract, logger } = input

  fs.mkdirSync(addonsDir, { recursive: true })
  const liveDir = path.join(addonsDir, addonId)
  // Place the temp + backup dirs as SIBLINGS of the live dir (same parent →
  // same filesystem → atomic rename). Deriving them from the live dir's parent
  // and basename keeps a scoped `addonId` like "@camstack/addon-pipeline" — whose
  // slash would otherwise turn `.<addonId>.next` into a nested path — correct.
  const liveParent = path.dirname(liveDir)
  const liveBase = path.basename(liveDir)
  fs.mkdirSync(liveParent, { recursive: true })
  const token = randomBytes(6).toString('hex')
  const nextDir = path.join(liveParent, `.${liveBase}.next.${token}`)
  const backupDir = path.join(liveParent, `.${liveBase}.backup.${token}`)

  // 1. Extract into a temp dir. If extraction throws (e.g. a killed untar),
  //    drop the temp dir and rethrow — the live dir is never touched.
  fs.mkdirSync(nextDir, { recursive: true })
  try {
    await extract(bundle, nextDir)
  } catch (err) {
    rmrf(nextDir)
    throw err
  }

  // 2. Swap. Back up the live dir (if present), then move next → live. On any
  //    failure, restore the backup so the addon stays installed at the old
  //    version.
  const hadLive = fs.existsSync(liveDir)
  if (hadLive) {
    fs.renameSync(liveDir, backupDir)
  }
  try {
    moveDir(nextDir, liveDir)
  } catch (swapErr) {
    if (hadLive) {
      try {
        if (fs.existsSync(liveDir)) rmrf(liveDir)
        fs.renameSync(backupDir, liveDir)
      } catch (restoreErr) {
        logger.error(
          `agent deploy swap: restore of "${addonId}" failed after a failed swap — manual recovery may be needed`,
          {
            meta: {
              backupDir,
              error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
            },
          },
        )
      }
    }
    rmrf(nextDir)
    throw swapErr
  }

  // 3. Success — drop the backup.
  if (hadLive) rmrf(backupDir)
  return { addonDir: liveDir }
}
