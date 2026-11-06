/**
 * What the hub knows about a runner that gave up, read at the moment it
 * gives up: the operator-facing name (from the package manifest on disk) and
 * the real cause (the runner's own last stderr line). Both travel in the
 * `addon.runner-failed` / `addon.runner-refused` payload so every alert and
 * notification built from the event names the same thing, with no lookup.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { redactLogText } from '../../logging/log-redactor.js'

/** Opening words of the breaker's own `addon.crashed` text. It describes the breaker, never the cause. */
export const CRASH_BREAKER_ERROR_PREFIX = 'Crash circuit-breaker tripped'

const MAX_CAUSE_LENGTH = 300
const INIT_FAILED = /Init failed for "[^"]*":\s*(.+)$/

/** The cause out of one stderr line: the text after `Init failed for "<id>":`, else the line itself. */
export function causeOfStderrLine(line: string): string | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  const init = INIT_FAILED.exec(trimmed)
  return (init?.[1] ?? trimmed).slice(0, MAX_CAUSE_LENGTH)
}

/** What stderr has said so far: the cause, and whether it came from an `Init failed` line. */
export interface RunnerCause {
  readonly text: string
  readonly fromInit: boolean
}

/** Fold a stderr chunk into the runner's last known cause. An `Init failed` line outranks later noise. */
export function lastCauseAfterChunk(
  previous: RunnerCause | undefined,
  chunk: string,
): RunnerCause | undefined {
  let cause = previous
  for (const line of chunk.split('\n')) {
    const text = causeOfStderrLine(line)
    if (text === undefined) continue
    const fromInit = INIT_FAILED.test(line.trim())
    // The cause travels into alerts and notifications: never a credential.
    if (fromInit || cause === undefined || !cause.fromInit)
      cause = { text: redactLogText(text), fromInit }
  }
  return cause
}

/** Manifest display name of the runner: the addon whose id is the runner's, else the only addon hosted. */
export function readRunnerDisplayName(
  addonDirs: readonly string[],
  runnerId: string,
): string | undefined {
  const names: { readonly id: string; readonly name: string }[] = []
  for (const dir of addonDirs) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
      const camstack: unknown =
        typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'camstack') : null
      const addons: unknown =
        typeof camstack === 'object' && camstack !== null ? Reflect.get(camstack, 'addons') : null
      if (!Array.isArray(addons)) continue
      for (const entry of addons) {
        const id: unknown =
          typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'id') : null
        const name: unknown =
          typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'name') : null
        if (typeof id === 'string' && typeof name === 'string' && name.trim().length > 0)
          names.push({ id, name: name.trim() })
      }
    } catch {
      // an unreadable manifest is a missing name, never a failed alert
    }
  }
  return (
    names.find((n) => n.id === runnerId)?.name ?? (names.length === 1 ? names[0]?.name : undefined)
  )
}
