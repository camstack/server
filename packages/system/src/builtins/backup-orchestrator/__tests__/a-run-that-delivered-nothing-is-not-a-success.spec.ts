/**
 * D384 — "never ran" must never look like "ran".
 *
 * Measured on the hub, 2026-09-07: the `Unraid` schedule (cron `0 3 * * *`,
 * fan-out `backups:smb`) fired at 03:00:26, the SMB upload was refused with
 * `smb-storage: location "backups:smb" missing config.share`, and every
 * surface an operator can read said the opposite:
 *
 *   - `backup.listRuns` reported `state: "succeeded"` with
 *     `completedDestinationIds: []` and `failedDestinationIds: ["backups:smb"]`;
 *   - `backup.trigger` resolved with `entries: []` and no error;
 *   - the schedule's `lastRunAt` — documented as "last SUCCESSFUL run" — was
 *     stamped BEFORE the archive ran and never corrected, so the destinations
 *     screen said "last run tonight" about a run that delivered zero bytes.
 *
 * This suite pins the queue half: a run whose destinations were all refused
 * is `failed`, and the reason names them.
 */
import { describe, expect, it } from 'vitest'
import { BackupRunQueue } from '../run-queue.js'

/** Yield the microtask queue so the pump can advance. */
async function settle(): Promise<void> {
  await new Promise((res) => setImmediate(res))
}

describe('a backup run that delivered to no destination', () => {
  it('is FAILED, not succeeded — and the error names the destinations that refused', async () => {
    const queue = new BackupRunQueue<readonly string[]>(async (_req, _signal, progress) => {
      progress.setDestinations(['backups:smb'])
      progress.destinationFailed('backups:smb')
      return []
    })

    const run = queue.submit({ destinations: ['backups:smb'], label: 'nightly' })
    await run.result
    await settle()

    const snap = queue.getRun(run.runId)
    expect(snap?.state).toBe('failed')
    expect(snap?.error).toContain('backups:smb')
  })

  it('stays SUCCEEDED when at least one destination landed the archive', async () => {
    const queue = new BackupRunQueue<readonly string[]>(async (_req, _signal, progress) => {
      progress.setDestinations(['backups:default', 'backups:smb'])
      progress.destinationCompleted('backups:default')
      progress.destinationFailed('backups:smb')
      return ['one']
    })

    const run = queue.submit({ destinations: ['backups:default', 'backups:smb'] })
    await run.result
    await settle()

    expect(queue.getRun(run.runId)?.state).toBe('succeeded')
  })

  it('stays SUCCEEDED when the run legitimately had no destination to write to', async () => {
    // `runBackupBuild` returns early (and logs) when the selection is empty.
    // That is a configuration outcome, not a delivery failure.
    const queue = new BackupRunQueue<readonly string[]>(async () => [])
    const run = queue.submit({})
    await run.result
    await settle()

    expect(queue.getRun(run.runId)?.state).toBe('succeeded')
  })
})
