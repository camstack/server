/**
 * The end-of-window digest — "here is what I hid while you were asleep".
 *
 * These tests exist because the digest carried one of the two private
 * `plural()` helpers this package used to have. Each was an `n === 1` check
 * with the English suffix baked in, and each had decided the question on its
 * own. The digest's outputs are pinned here byte-for-byte in English, so the
 * fold into the catalog is provably an equivalence, and pinned in Italian so
 * that the plural is the LANGUAGE's and not English's wearing Italian words.
 */

import type { NcSnooze, NcSnoozeSuppressed } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildSnoozeDigest, digestTargets } from '../snooze-digest.js'
import { NcTextCatalog } from '../text-catalog.js'

const EN = new NcTextCatalog()
const IT = new NcTextCatalog({ language: 'it' })

/** 14:03 and 15:03 in the host zone — the digest prints local wall clock. */
const FROM = new Date(2026, 0, 5, 14, 3).getTime()
const TO = new Date(2026, 0, 5, 15, 3).getTime()

function snooze(over: Partial<NcSnooze> = {}): NcSnooze {
  return {
    id: 'sn-1',
    userId: 'u1',
    scope: 'all',
    startedAt: FROM,
    expiresAt: TO,
    global: false,
    summary: true,
    ...over,
  }
}

function row(over: Partial<NcSnoozeSuppressed> = {}): NcSnoozeSuppressed {
  return {
    snoozeId: 'sn-1',
    targetId: 'tgt-1',
    ruleId: 'r-1',
    ruleName: 'Person at gate',
    deviceId: 104,
    count: 3,
    firstAt: FROM,
    lastAt: TO,
    ...over,
  }
}

const NAMES = new Map([[104, 'Front door']])

describe('buildSnoozeDigest — English, byte-for-byte what it always said', () => {
  it('titles with the plural count and lists what was hidden', () => {
    const digest = buildSnoozeDigest(EN, snooze(), [row()], NAMES)
    expect(digest).toEqual({
      title: 'Snooze ended — 3 notifications hidden',
      body: 'Everything was snoozed, 14:03–15:03.\n• Person at gate on Front door — 3',
      total: 3,
    })
  })

  it('uses the SINGULAR at one', () => {
    expect(buildSnoozeDigest(EN, snooze(), [row({ count: 1 })], NAMES)?.title).toBe(
      'Snooze ended — 1 notification hidden',
    )
  })

  it('says "for everyone" for a global window — a different sentence, not a suffix', () => {
    expect(buildSnoozeDigest(EN, snooze({ global: true }), [row()], NAMES)?.body).toContain(
      'Everything was snoozed for everyone, 14:03–15:03.',
    )
  })

  it('names the rule for a rule-scoped window, and the camera for a device one', () => {
    expect(
      buildSnoozeDigest(EN, snooze({ scope: 'rule', ruleId: 'r-1' }), [row()], NAMES)?.body,
    ).toContain('“Person at gate” was snoozed')
    expect(
      buildSnoozeDigest(EN, snooze({ scope: 'device', deviceId: 104 }), [row()], NAMES)?.body,
    ).toContain('Front door was snoozed')
  })

  it('falls back honestly when the scope names something the rows do not', () => {
    expect(
      buildSnoozeDigest(EN, snooze({ scope: 'rule', ruleId: 'gone' }), [row()], NAMES)?.body,
    ).toContain('A rule was snoozed')
    expect(buildSnoozeDigest(EN, snooze({ scope: 'device' }), [row()], NAMES)?.body).toContain(
      'A camera was snoozed',
    )
  })

  it('puts the busiest rule first — the line that explains the silence', () => {
    const digest = buildSnoozeDigest(
      EN,
      snooze(),
      [
        row({ ruleId: 'a', ruleName: 'Quiet', count: 1 }),
        row({ ruleId: 'b', ruleName: 'Loud', count: 9 }),
      ],
      NAMES,
    )
    expect(digest?.body.split('\n').slice(1)).toEqual([
      '• Loud on Front door — 9',
      '• Quiet on Front door — 1',
    ])
    expect(digest?.total).toBe(10)
  })

  it('sends NOTHING when the window hid nothing', () => {
    expect(buildSnoozeDigest(EN, snooze(), [row({ count: 0 })], NAMES)).toBeNull()
  })

  it('falls back to `camera <id>` for an unnamed device', () => {
    expect(buildSnoozeDigest(EN, snooze(), [row({ deviceId: 999 })], NAMES)?.body).toContain(
      '• Person at gate on camera 999 — 3',
    )
  })
})

describe('buildSnoozeDigest — Italian', () => {
  it('pluralises by the LANGUAGE rules at 1 and at N', () => {
    expect(buildSnoozeDigest(IT, snooze(), [row({ count: 1 })], NAMES)?.title).toBe(
      'Pausa terminata — 1 notifica nascosta',
    )
    expect(buildSnoozeDigest(IT, snooze(), [row()], NAMES)?.title).toBe(
      'Pausa terminata — 3 notifiche nascoste',
    )
  })

  it('translates the header, the scope word and the line', () => {
    expect(buildSnoozeDigest(IT, snooze(), [row()], NAMES)?.body).toBe(
      'Tutto in pausa, 14:03–15:03.\n• Person at gate su Front door — 3',
    )
    expect(buildSnoozeDigest(IT, snooze({ global: true }), [row()], NAMES)?.body).toContain(
      'Tutto in pausa per tutti,',
    )
  })
})

describe('digestTargets', () => {
  it('is the distinct set of targets the window owes a digest to', () => {
    expect(digestTargets([row(), row({ targetId: 'tgt-2' }), row({ targetId: 'tgt-1' })])).toEqual([
      'tgt-1',
      'tgt-2',
    ])
  })
})
