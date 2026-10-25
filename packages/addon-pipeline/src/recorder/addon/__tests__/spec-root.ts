/**
 * A scratch directory that belongs to THIS run of THIS spec file.
 *
 * D551 fixed six spec files that shared one fixed `/tmp` dataDir on a
 * self-hosted runner whose `/tmp` outlives the job. The recorder's specs are
 * the same bet under a different name: `path.join(os.tmpdir(),
 * 'rec-controller-spec')` is one path, shared by every test in the file, by
 * every run of the file, and by every job the runner has executed since it was
 * started. Inspected on `ci-runner` 2026-09-20, `/tmp/rec-controller-spec`
 * and its siblings were still there with a creation date of **2026-08-20** —
 * a month of accumulated staging directories that every recorder test has been
 * reading through.
 *
 * `mkdtemp` makes the name unique per run, and the process removes what it
 * made. Nothing a previous job wrote can reach this run.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Every root this worker made, removed together on the way out. */
const made: string[] = []
let sweeping = false

/** A fresh scratch root, removed when the worker exits. */
function specRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  made.push(dir)
  // ONE listener however many roots a worker asks for. One per root put 11
  // listeners on `process` and Node warned about a leak.
  if (!sweeping) {
    sweeping = true
    process.once('exit', () => {
      for (const d of made) rmSync(d, { recursive: true, force: true })
    })
  }
  return dir
}

export { specRoot }
