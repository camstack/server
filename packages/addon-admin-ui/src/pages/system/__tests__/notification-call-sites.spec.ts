/**
 * THE CALL-SITE GUARD for the Notification pages.
 *
 * ## The failure it pins
 *
 * Operator report, 2026-08-14: the Timelapses tab answered
 * `NOT_FOUND: notificationCenter.listTimelapseRules`. There is no such tRPC
 * namespace — the hub exposes `notificationOutput` and `notificationRules`, and
 * every timelapse/summary/text/artifact read rides the GENERIC bridge
 * (`addons.custom` with `addonId: 'pipeline-analytics'`, action `nc.*`), which is
 * exactly why those features ship without a release train.
 *
 * A repo-wide search found that string in no source at all — not in this
 * package, not in `packages/*`, not in the viewer submodule. So the deployed
 * bundle was OLDER than the move onto the bridge: the stale-addon case
 * `CLAUDE.md` opens with ("your edit is probably not running"), and the remedy
 * is a redeploy, not a patch.
 *
 * Which leaves one thing worth building: a guard that makes the shape of that
 * mistake unrepresentable in source, so a future refactor cannot reintroduce a
 * namespace the hub does not serve and have it discovered by an operator.
 *
 * ## Why a SOURCE scan
 *
 * The mistake is a STRING. A render test proves one path works; it cannot prove
 * that no other file names a namespace that does not exist, and the tRPC client
 * behind `useSystem()` is typed loosely enough at these call sites that a bad
 * namespace type-checks in a mock. Scanning the sources is the cheapest total
 * check — the same reason this repo prefers a guard to a paragraph.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PAGES_DIR = join(import.meta.dirname, '..')

/** Every notification-related source on the page layer. */
function notificationSources(): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(PAGES_DIR)
    .filter((name) => /^(Notification|notification-)/.test(name))
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => ({ file: name, text: readFileSync(join(PAGES_DIR, name), 'utf8') }))
}

/**
 * The tRPC namespaces the hub actually serves for notifications.
 *
 * `notificationRules` and `notificationOutput` are the two CAPS; everything else
 * a Notification tab needs is an addon action on the generic bridge. A third
 * name here would mean a new cap, which means codegen and a release train — so
 * a name appearing in source that is not one of these is a bug, not a feature.
 */
const SERVED_NOTIFICATION_NAMESPACES: readonly string[] = [
  'notificationRules',
  'notificationOutput',
]

/** The addon every `nc.*` action is served by. */
const NC_ADDON_ID = 'pipeline-analytics'

describe('the Notification pages only call namespaces the hub serves', () => {
  it('never names a `notificationCenter` router — there is no such namespace', () => {
    for (const { file, text } of notificationSources()) {
      expect(text, `${file} names a tRPC namespace the hub does not serve`).not.toMatch(
        /trpcClient\s*\.\s*notificationCenter/,
      )
    }
  })

  it('every `trpcClient.notification*` call names one of the two real caps', () => {
    const pattern = /trpcClient\s*\.\s*(notification[A-Za-z]*)/g
    for (const { file, text } of notificationSources()) {
      for (const match of text.matchAll(pattern)) {
        const namespace = match[1]!
        expect(
          SERVED_NOTIFICATION_NAMESPACES,
          `${file} calls trpcClient.${namespace}, which is not a served cap — an addon action belongs on addons.custom`,
        ).toContain(namespace)
      }
    }
  })

  it('every SEND on the generic bridge names the hosting addon', () => {
    // Pins the OTHER half of the same mistake: an `nc.*` action sent to the
    // wrong addon id answers NOT_FOUND in exactly the same way. Only the files
    // that actually CALL the bridge are checked — an action NAME may legitimately
    // be declared in a helper whose module never sends anything.
    let senders = 0
    for (const { file, text } of notificationSources()) {
      // A CALL, not a mention: the parser modules name the bridge in their
      // docblocks and send nothing.
      if (!/addons\s*\.\s*custom\s*\.\s*(mutate|query)\s*\(/.test(text)) continue
      senders += 1
      expect(text, `${file} calls addons.custom without naming the hosting addon`).toMatch(
        new RegExp(`${NC_ADDON_ID}|NC_ADDON_ID`),
      )
    }
    // A guard that matched nothing is a guard that passes forever. The pages DO
    // use the bridge; if this drops to zero the pattern above has rotted.
    expect(senders).toBeGreaterThan(0)
  })
})
