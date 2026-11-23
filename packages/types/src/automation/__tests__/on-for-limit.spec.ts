/** An "on for" hold may not outlast the device's run limit (D1092 x D993). */
import { describe, expect, it } from 'vitest'
import { caseEntity, edited, SITE } from '../draft/__tests__/draft-fixtures.js'
import { validateDraft } from '../draft/validate-draft.js'
import { type OnForHold, OnForHolds } from '../on-for.js'

const HEATER = 3
const NOW = 1_000_000
const HOUR_MS = 3_600_000

function rig(limitSeconds: number | null, stored: readonly OnForHold[] = []) {
  const persisted: OnForHold[][] = []
  const clamped: string[] = []
  const holds = new OnForHolds<number>({
    timers: { now: () => NOW, set: () => 1, clear: () => undefined },
    readOn: async () => false,
    send: async () => undefined,
    persist: async (list) => {
      persisted.push([...list])
    },
    limitSecondsOf: async () => limitSeconds,
    onClamped: (id, asked, limit) => clamped.push(`${id}:${asked}:${limit}`),
  })
  holds.restore(stored)
  return { holds, persisted, clamped }
}

describe('OnForHolds limit', () => {
  it('cuts a new hold to the device limit', async () => {
    const r = rig(10_800)
    await r.holds.trigger(HEATER, 'switch.on', 24 * HOUR_MS)
    expect(r.holds.list()[0]?.deadline).toBe(NOW + 3 * HOUR_MS)
    expect(r.clamped).toEqual([`${HEATER}:${24 * HOUR_MS}:${3 * HOUR_MS}`])
  })

  it('keeps a hold inside the limit as asked', async () => {
    const r = rig(10_800)
    await r.holds.trigger(HEATER, 'switch.on', HOUR_MS)
    expect(r.holds.list()[0]?.deadline).toBe(NOW + HOUR_MS)
    expect(r.clamped).toEqual([])
  })

  it('cuts a stored hold already over the limit, and stores the cut', async () => {
    const r = rig(10_800, [{ deviceId: HEATER, cap: 'switch', deadline: NOW + 24 * HOUR_MS }])
    await r.holds.idle()
    expect(r.holds.list()[0]?.deadline).toBe(NOW + 3 * HOUR_MS)
    expect(r.persisted.at(-1)?.[0]?.deadline).toBe(NOW + 3 * HOUR_MS)
  })

  it('changes nothing when the limit cannot be told', async () => {
    const r = rig(null)
    await r.holds.trigger(HEATER, 'switch.on', 24 * HOUR_MS)
    expect(r.holds.list()[0]?.deadline).toBe(NOW + 24 * HOUR_MS)
  })
})

describe('validateDraft on an on-for step', () => {
  const site = {
    ...SITE,
    devices: [
      ...SITE.devices,
      {
        id: 9101,
        name: 'Heater',
        type: 'switch',
        role: 'switch-heater',
        room: null,
        addonId: 'x',
        stableId: 'heater',
        caps: ['switch'],
      },
    ],
  }
  const issuesFor = (seconds: number): readonly string[] => {
    const entity = edited(caseEntity('automation', 'auto-02'), (r) => {
      r['actions'] = [
        {
          kind: 'command',
          target: { kind: 'devices', ids: [9101] },
          actionId: 'switch.on',
          onFor: { seconds },
        },
      ]
    })
    const verdict = validateDraft('automation', entity, site)
    return verdict.ok ? [] : verdict.issues
  }

  it('refuses a hold over the heater limit', () => {
    expect(issuesFor(86_400).join('\n')).toContain('actions.0.onFor')
  })
  it('accepts a hold inside it', () => {
    expect(issuesFor(3_600).join('\n')).not.toContain('onFor')
  })
})
