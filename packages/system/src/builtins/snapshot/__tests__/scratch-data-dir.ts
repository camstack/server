/**
 * A private `ctx.dataDir` per stub context.
 *
 * Every snapshot spec used to hand the addon a FIXED path — `/tmp/snapshot-test`
 * and friends. That directory is shared by every test in the file, by every run
 * on the machine, and by every run on the CI runner, which keeps its `/tmp`
 * across jobs. `SnapshotDurableStore` writes the last good frame there, the
 * addon writes it fire-and-forget (`void this.durable.put(...)`), and the
 * DISABLED path reads it back before it ever reaches the courtesy render:
 *
 *   snapshot.addon.ts — `const base = hit ?? (await this.durableEntry(deviceId))`
 *
 * So "never dials a DISABLED camera, even when the courtesy render fails" was
 * asserting `null` while a real JPEG left behind by an earlier test decided the
 * answer. Whether the JPEG or the 2-byte junk from a later test landed last
 * depended on how those unawaited writes interleaved: green on an idle laptop,
 * red on a loaded 4-core runner — and red FOREVER on any machine whose `/tmp`
 * kept a decodable frame. This is the fix: nothing is shared, so nothing leaks.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created: string[] = []

let cleanupRegistered = false

/** A fresh, empty directory that no other context can see. */
export function freshSnapshotDataDir(): string {
  if (!cleanupRegistered) {
    cleanupRegistered = true
    process.on('exit', () => {
      for (const dir of created) rmSync(dir, { recursive: true, force: true })
    })
  }
  const dir = mkdtempSync(join(tmpdir(), 'camstack-snapshot-spec-'))
  created.push(dir)
  return dir
}
