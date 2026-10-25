/**
 * The indexes of every daily file in one logs directory (D898), kept by the
 * reader thread.
 *
 * - `indexOf(file)` brings that file's index up to the bytes written so far
 *   (cheap for the live file: only the bytes since the last call) and returns
 *   it. A file whose index is still being built answers with the part that
 *   exists; the reader scans the rest without skipping.
 * - `backgroundPass()` indexes every file, newest first, yielding between
 *   chunks so a read is never queued behind it, and removes sidecars whose
 *   log file the rotation deleted.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { LOG_FILE_NAME_RE } from './log-file-cursor.js'
import {
  catchUpFileIndex,
  indexEnd,
  loadFileIndex,
  type FileIndex,
  type Yield,
} from './log-file-index.js'

interface Entry {
  index: FileIndex
  rewrite: boolean
  /** Serialises catch-ups of one file. */
  busy: Promise<void>
  running: boolean
}

/** Unindexed bytes a read waits for before scanning; more is indexed behind it. */
const SYNC_CATCH_UP_BYTES = 8 * 1024 * 1024

const yieldToEventLoop: Yield = () => new Promise((resolve) => setImmediate(resolve))

export class LogFileIndexStore {
  private readonly files = new Map<string, Entry>()

  constructor(private readonly logsDir: string) {}

  async indexOf(
    fileName: string,
    opts: { readonly wait?: boolean } = {},
  ): Promise<FileIndex | null> {
    if (!LOG_FILE_NAME_RE.test(fileName)) return null
    const logPath = path.join(this.logsDir, fileName)
    let stat
    try {
      stat = await fs.stat(logPath)
    } catch {
      this.files.delete(fileName)
      return null
    }
    let entry = this.files.get(fileName)
    if (entry === undefined || entry.index.ino !== stat.ino) {
      const loaded = await loadFileIndex(logPath, stat.ino, stat.size)
      entry = {
        index: loaded.index,
        rewrite: loaded.rewrite,
        busy: Promise.resolve(),
        running: false,
      }
      this.files.set(fileName, entry)
    }
    const current = entry
    if (current.running) return current.index
    const run = current.busy.then(async () => {
      current.running = true
      const rewrite = current.rewrite
      current.rewrite = false
      try {
        await catchUpFileIndex(logPath, current.index, { rewrite, yieldFn: yieldToEventLoop })
      } catch {
        // A sidecar that cannot be written is a missing optimisation, never a
        // failed read: the reader scans what the index does not cover.
        current.rewrite = true
      } finally {
        current.running = false
      }
    })
    current.busy = run
    // A small gap (the live file since the last read) is worth waiting for; a
    // large one (a day nobody indexed yet) is built behind the read, which
    // scans that part unskipped meanwhile.
    if (opts.wait === true || stat.size - indexEnd(current.index) <= SYNC_CATCH_UP_BYTES) {
      await run
    }
    return current.index
  }

  /** Index everything, newest first; drop orphaned sidecars. */
  async backgroundPass(shouldStop: () => boolean): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(this.logsDir)
    } catch {
      return
    }
    const logs = new Set(names.filter((n) => LOG_FILE_NAME_RE.test(n)))
    for (const name of names) {
      if (!name.endsWith('.log.idx')) continue
      const log = name.slice(0, -'.idx'.length)
      if (!logs.has(log)) await fs.rm(path.join(this.logsDir, name), { force: true })
    }
    for (const name of [...logs].toSorted().toReversed()) {
      if (shouldStop()) return
      await this.indexOf(name, { wait: true })
    }
  }
}
