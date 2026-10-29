/**
 * The shell's own persistent log (`<userData>/shell.log`).
 *
 * The OS captures the main process's stdout only when the app was launched from
 * a terminal, and a closed stdout throws on write — so the one place a fatal
 * shell error is guaranteed to land is a file. Bounded: when the file passes
 * `maxBytes` it becomes `<file>.1` (one previous generation), so the log can
 * never grow without limit. Writing never throws and never shows a dialog.
 */
import * as fs from 'node:fs'

export const SHELL_LOG_MAX_BYTES = 1024 * 1024

export interface ShellLogOptions {
  readonly maxBytes?: number
  readonly now?: () => number
}

export function appendShellLog(file: string, line: string, options: ShellLogOptions = {}): void {
  const maxBytes = options.maxBytes ?? SHELL_LOG_MAX_BYTES
  const stamp = new Date((options.now ?? Date.now)()).toISOString()
  try {
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`)
    } catch {
      /* absent file: nothing to rotate */
    }
    fs.appendFileSync(file, `${stamp} ${line}\n`)
  } catch {
    /* a log that cannot be written must not become the next failure */
  }
}

/** One log entry for a process-level fatal: the stack of an Error, the text of anything else. */
export function formatFatal(
  kind: 'uncaughtException' | 'unhandledRejection',
  reason: unknown,
): string {
  if (reason instanceof Error) return `${kind}: ${reason.stack ?? reason.message}`
  return `${kind}: ${String(reason)}`
}
