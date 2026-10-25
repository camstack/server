/**
 * Recognise a recorder writer in the process table (D667).
 *
 * A writer is recognised by the ARGV it was started with. Two parts decide it:
 * the executable is an ffmpeg, and `-segment_list` names a staging playlist.
 * The directory is what makes it a rival, not the binary: another node's
 * writers are in another pid namespace or on another host, and a writer of a
 * different directory is not competing for this one.
 *
 * Linux gives the exact argv, so every comparison there is exact. macOS `ps`
 * gives one space-joined string, so the match is a substring with a boundary
 * check on both sides. A profile name therefore may not contain a space. The
 * recorder's are `high`, `mid` and `low`.
 */
import path from 'node:path'
import type { ListedProcess } from './process-table.js'
import { STAGING_DIR_NAME } from './recording-controller.js'

/** The argv flag every recorder writer carries, used to narrow the table read. */
export const SEGMENT_LIST_FLAG = '-segment_list'
/** What the executable's name must contain. `camstack deploy`'s ffmpeg, a
 *  jellyfin build and a system one all carry it. */
export const DEFAULT_EXECUTABLE_MARKER = 'ffmpeg'

/** One staging directory and whose it is. */
export interface WriterTarget {
  readonly deviceId: number
  readonly profile: string
  /** The recordings location root the directory lives under. */
  readonly root: string
  readonly outDir: string
}

/**
 * True when the process was started from an executable whose name contains
 * `marker`. Without this, a `pgrep -f`, a `grep` or an `sh -c` wrapper that
 * merely mentions the playlist would be signalled on macOS, where the argv
 * cannot be told apart from the command text.
 */
export function isWriterExecutable(proc: ListedProcess, marker: string): boolean {
  if (proc.argv !== null) {
    const exe = proc.argv[0]
    return exe !== undefined && path.basename(exe).includes(marker)
  }
  // `ps`: the executable is everything before the first flag. A path with a
  // space in it (`/Applications/My App/ffmpeg -hide_banner …`) survives this.
  const flagAt = proc.command.indexOf(' -')
  const exe = flagAt < 0 ? proc.command : proc.command.slice(0, flagAt)
  return path.basename(exe).includes(marker)
}

/** True when this process was started as a writer of `playlistPath`. */
export function writesPlaylist(proc: ListedProcess, playlistPath: string): boolean {
  if (proc.argv !== null) {
    for (let i = 0; i < proc.argv.length - 1; i++) {
      if (proc.argv[i] === SEGMENT_LIST_FLAG && proc.argv[i + 1] === playlistPath) return true
    }
    return false
  }
  // `ps` gives one joined string. The needle carries the whole path, and the
  // character after it must end the argument: `/a/live.m3u8` must not match
  // `/a/live.m3u8.old`, nor `-segment_list /x` match `-segment_list /x/y`.
  const needle = `${SEGMENT_LIST_FLAG} ${playlistPath}`
  let from = 0
  for (;;) {
    const at = proc.command.indexOf(needle, from)
    if (at < 0) return false
    const before = at === 0 ? ' ' : proc.command[at - 1]
    const after = proc.command[at + needle.length]
    if (before === ' ' && (after === undefined || after === ' ')) return true
    from = at + 1
  }
}

const TAIL = /^(\d+)\/([^/\s]+)\/live\.m3u8$/
const TAIL_IN_COMMAND = /^(\d+)\/([^/\s]+)\/live\.m3u8(?= |$)/

function targetFromTail(root: string, tail: string, pattern: RegExp): WriterTarget | null {
  const match = pattern.exec(tail)
  if (match === null) return null
  const deviceId = Number(match[1])
  const profile = match[2]
  if (!Number.isSafeInteger(deviceId) || profile === undefined) return null
  return {
    deviceId,
    profile,
    root,
    outDir: path.join(root, STAGING_DIR_NAME, String(deviceId), profile),
  }
}

/**
 * The staging directory this process writes, when it writes one under any of
 * `roots` — `<root>/.rec-tmp/<deviceId>/<profile>/live.m3u8`, nothing looser.
 * Used by the sweeps, which do not know in advance which directories hold an
 * orphan.
 */
export function stagingTargetOf(
  proc: ListedProcess,
  roots: readonly string[],
): WriterTarget | null {
  for (const root of roots) {
    const prefix = `${path.join(root, STAGING_DIR_NAME)}/`
    if (proc.argv !== null) {
      for (let i = 0; i < proc.argv.length - 1; i++) {
        const value = proc.argv[i + 1]
        if (proc.argv[i] !== SEGMENT_LIST_FLAG || value === undefined) continue
        if (!value.startsWith(prefix)) continue
        const target = targetFromTail(root, value.slice(prefix.length), TAIL)
        if (target !== null) return target
      }
      continue
    }
    const needle = `${SEGMENT_LIST_FLAG} ${prefix}`
    let from = 0
    for (;;) {
      const at = proc.command.indexOf(needle, from)
      if (at < 0) break
      const before = at === 0 ? ' ' : proc.command[at - 1]
      if (before === ' ') {
        const tail = proc.command.slice(at + needle.length)
        const target = targetFromTail(root, tail, TAIL_IN_COMMAND)
        if (target !== null) return target
      }
      from = at + 1
    }
  }
  return null
}
