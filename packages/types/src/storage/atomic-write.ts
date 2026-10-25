import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Errors a Windows rename over a file another process has open can raise. */
const WINDOWS_RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const WINDOWS_RENAME_RETRIES = 3
const WINDOWS_RENAME_RETRY_MS = 25

function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined
}

/**
 * Replace `filePath` with `data` so that a concurrent reader sees EITHER the
 * old complete file OR the new complete file — never a prefix (D654).
 *
 * A plain `writeFile` truncates the target and then writes it in chunks, so a
 * reader in between gets a torn file: a fixed-path single-instance media kind
 * (`lastFrame`, `lastSceneFrame`) is overwritten every roll while a
 * notification may be reading it. Here the bytes go to a temp file in the SAME
 * directory (same filesystem, so the rename cannot degrade to a copy), and a
 * `rename` swaps it in — atomic on POSIX. A reader that already opened the old
 * file keeps reading the old inode to the end.
 *
 * The temp name is DOT-prefixed so every directory scan that skips dot entries
 * (occupancy, D327) never counts it; it is removed on any failure. A process
 * killed between the write and the rename leaves one `.<name>.<uuid>.tmp`.
 *
 * Windows: a rename over a file another process holds open can fail with
 * EPERM/EACCES/EBUSY. It is retried briefly and then falls back to copying the
 * temp over the target — non-atomic, exactly the pre-D654 behaviour, rather
 * than losing the write.
 *
 * Cost: one extra `rename` (and, on failure, one `rm`) per write — a metadata
 * operation, independent of the payload size.
 */
export async function writeFileAtomic(filePath: string, data: Uint8Array): Promise<void> {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  try {
    await fs.promises.writeFile(tmp, data)
    await renameOver(tmp, filePath)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function renameOver(tmp: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rename(tmp, filePath)
      return
    } catch (err) {
      const code = errnoCode(err)
      const busyOnWindows =
        process.platform === 'win32' && code !== undefined && WINDOWS_RENAME_BUSY.has(code)
      if (!busyOnWindows) throw err
      if (attempt < WINDOWS_RENAME_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, WINDOWS_RENAME_RETRY_MS))
        continue
      }
      await fs.promises.copyFile(tmp, filePath)
      await fs.promises.rm(tmp, { force: true })
      return
    }
  }
}
