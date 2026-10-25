/**
 * The end-of-window summary — "here is what I hid while you were asleep".
 *
 * Pure: a window, its counters and a name for each camera in, one
 * title/body out. The delivery half lives in the dispatcher, which already
 * owns target resolution and device names.
 *
 * Default ON by operator decision, because the two people who set a snooze want
 * opposite things: whoever silenced a nuisance camera does not care, and
 * whoever silenced a SECURITY camera needs to know what they missed. A snooze
 * that hides events and never says so is indistinguishable from an outage —
 * this message is the difference.
 */

import type { NcSnooze, NcSnoozeSuppressed } from '@camstack/types'
import type { NcTextCatalog } from './text-catalog.js'

export interface NcSnoozeDigest {
  readonly title: string
  readonly body: string
  /** How many notifications the window hid for this target. */
  readonly total: number
}

/** `14:03` in the node's local zone — a digest is read by a person, at home. */
function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * What the window covered, in the words the operator chose it with — the rule's
 * NAME, the camera's name. "a rule was snoozed" tells the reader nothing they
 * could act on.
 */
function scopeLabel(
  texts: NcTextCatalog,
  snooze: NcSnooze,
  rows: readonly NcSnoozeSuppressed[],
  deviceNames: ReadonlyMap<number, string>,
): string {
  switch (snooze.scope) {
    case 'all':
      return texts.text({ key: 'snooze.scope.all' })
    case 'device': {
      const id = snooze.deviceId
      if (id === undefined) return texts.text({ key: 'snooze.scope.anyDevice' })
      return deviceNames.get(id) ?? `Camera ${id}`
    }
    case 'rule': {
      const named = rows.find((r) => r.ruleId === snooze.ruleId)
      if (named === undefined) return texts.text({ key: 'snooze.scope.anyRule' })
      return texts.text({ key: 'snooze.scope.rule', vars: { rule: named.ruleName } })
    }
  }
}

/**
 * One digest for ONE target — the counters passed in are already the rows
 * belonging to it, so the message says what THAT destination missed rather
 * than what the household did.
 *
 * Returns null when the window hid nothing: "snooze ended, 0 notifications" is
 * a notification the operator did not need, and sending it for every quiet
 * window is how a summary becomes the noise it was meant to suppress.
 */
export function buildSnoozeDigest(
  texts: NcTextCatalog,
  snooze: NcSnooze,
  rows: readonly NcSnoozeSuppressed[],
  deviceNames: ReadonlyMap<number, string>,
): NcSnoozeDigest | null {
  const total = rows.reduce((sum, r) => sum + r.count, 0)
  if (total === 0) return null

  const from = clock(Math.min(...rows.map((r) => r.firstAt)))
  const to = clock(snooze.expiresAt)
  // Plural by the LANGUAGE's rules. The private `n === 1` helper this replaced
  // was right for English and wrong for anything else — and it was one of two
  // in this package that had each decided the question separately.
  const title = texts.text({
    key: 'snooze.digest.title',
    count: total,
    vars: { total: `${total}` },
  })

  // Busiest first: the line that explains the silence should be the first one
  // read, not the alphabetically luckiest.
  const lines = rows
    .toSorted((a, b) => b.count - a.count || a.ruleName.localeCompare(b.ruleName))
    .map((r) =>
      texts.text({
        key: 'snooze.digest.line',
        vars: {
          rule: r.ruleName,
          camera: deviceNames.get(r.deviceId) ?? `camera ${r.deviceId}`,
          count: `${r.count}`,
        },
      }),
    )

  const header = texts.text({
    // Global and personal are two sentences, not one with a clause bolted on:
    // "for everyone" does not translate as a suffix.
    key: snooze.global ? 'snooze.digest.header.global' : 'snooze.digest.header',
    vars: { scope: scopeLabel(texts, snooze, rows, deviceNames), from, to },
  })

  return { title, body: [header, ...lines].join('\n'), total }
}

/** The distinct targets a window owes a digest to. */
export function digestTargets(rows: readonly NcSnoozeSuppressed[]): readonly string[] {
  return [...new Set(rows.map((r) => r.targetId))]
}
