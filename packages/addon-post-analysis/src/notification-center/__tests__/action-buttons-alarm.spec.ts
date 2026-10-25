/**
 * The buttons an ALARM notification carries.
 *
 * The state the notification REPORTS decides them, not the panel's state now:
 * the row may have waited in the outbox, and a "Disarm" button on a
 * notification that says the alarm was disarmed is a button that lies about
 * what it will do.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildAlarmButtons,
  type NcAlarmButtonLabels,
  type NcAlarmButtonMint,
  type NcAlarmButtonPanel,
} from '../action-buttons.js'

const PANEL: NcAlarmButtonPanel = { deviceId: 900, availableModes: ['home', 'away', 'night'] }

const labels: NcAlarmButtonLabels = {
  disarm: 'Disarma',
  arm: (mode) => `Arma ${mode}`,
  armAnyway: 'Arma comunque',
  bypassInput: 'Escludi fino al disinserimento',
}

const minted: NcAlarmButtonMint[] = []
const mintUrl = (i: NcAlarmButtonMint): string => {
  minted.push(i)
  return `https://h.example/nc-action/${i.actionId}?a=${i.action}`
}

beforeEach(() => {
  minted.length = 0
})

describe('a notification about a LIVE alarm offers the way out', () => {
  it('alarm-triggered → one destructive Disarm', () => {
    const out = buildAlarmButtons({ kind: 'alarm-triggered', panel: PANEL, mintUrl, labels })
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('alarm-disarm')
    expect(out[0]?.label).toBe('Disarma')
    expect(out[0]?.destructive).toBe(true)
    expect(out[0]?.icon).toBe('disarm')
    // BACKGROUND: Zentik fires POST:: without opening a browser tab.
    expect(out[0]?.mode).toBe('background')
  })

  it('alarm-armed → the same Disarm', () => {
    const out = buildAlarmButtons({ kind: 'alarm-armed', panel: PANEL, mintUrl, labels })
    expect(out.map((b) => b.id)).toEqual(['alarm-disarm'])
  })

  it('alarm-pending, alarm-rearmed and alarm-check-failed → one Disarm each', () => {
    for (const kind of ['alarm-pending', 'alarm-rearmed', 'alarm-check-failed'] as const) {
      const out = buildAlarmButtons({ kind, panel: PANEL, mintUrl, labels })
      expect(
        out.map((b) => b.id),
        kind,
      ).toEqual(['alarm-disarm'])
      expect(out[0]?.destructive, kind).toBe(true)
    }
  })

  it('alarm-sensor-bypass → nothing: it reports, there is nothing to undo', () => {
    expect(
      buildAlarmButtons({ kind: 'alarm-sensor-bypass', panel: PANEL, mintUrl, labels }),
    ).toEqual([])
  })
})

describe('a REFUSAL offers the Arm anyway bound to it — and only that', () => {
  it('one destructive background button, minted with the refusal id and nothing else', () => {
    const out = buildAlarmButtons({
      kind: 'alarm-arm-refused',
      panel: PANEL,
      refusalId: 'refusal:900:away:1000',
      mintUrl,
      labels,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('alarm-arm-anyway')
    expect(out[0]?.label).toBe('Arma comunque')
    expect(out[0]?.destructive).toBe(true)
    expect(out[0]?.mode).toBe('background')
    // No mode, no device ids: the panel's refusal record is the authority on
    // both, so an edited URL cannot widen what is excluded.
    expect(minted).toEqual([
      { actionId: 'alarm-arm-anyway', action: 'arm-anyway', refusalId: 'refusal:900:away:1000' },
    ])
  })

  it('a refused row with NO refusal id (an older addon wrote it) gets no button', () => {
    expect(buildAlarmButtons({ kind: 'alarm-arm-refused', panel: PANEL, mintUrl, labels })).toEqual(
      [],
    )
    expect(minted).toEqual([])
  })
})

describe('a DISARMED notification offers the way back in', () => {
  it('one Arm button per mode the panel declares, in the panel’s order', () => {
    const out = buildAlarmButtons({ kind: 'alarm-disarmed', panel: PANEL, mintUrl, labels })
    expect(out.map((b) => b.id)).toEqual(['alarm-arm-home', 'alarm-arm-away', 'alarm-arm-night'])
    expect(out.map((b) => b.label)).toEqual(['Arma home', 'Arma away', 'Arma night'])
    expect(out.every((b) => b.mode === 'background')).toBe(true)
    expect(out.every((b) => b.destructive === undefined)).toBe(true)
  })

  it('caps the list at three — a notification is not a menu', () => {
    const many: NcAlarmButtonPanel = {
      deviceId: 900,
      availableModes: ['home', 'away', 'night', 'vacation', 'custom_bypass'],
    }
    expect(
      buildAlarmButtons({ kind: 'alarm-disarmed', panel: many, mintUrl, labels }),
    ).toHaveLength(3)
  })

  it('a panel offering NO modes produces no buttons rather than an empty menu', () => {
    expect(
      buildAlarmButtons({
        kind: 'alarm-disarmed',
        panel: { deviceId: 900, availableModes: [] },
        mintUrl,
        labels,
      }),
    ).toEqual([])
  })
})

describe('no panel, no buttons', () => {
  it('is a no-op for every kind — never a button pointing at a panel that is not here', () => {
    // The live hub answered `deviceId: null` for a while; the button surface
    // must be correct whether or not that is true on a given node.
    for (const kind of ['alarm-triggered', 'alarm-armed', 'alarm-disarmed'] as const) {
      expect(buildAlarmButtons({ kind, panel: null, mintUrl, labels })).toEqual([])
    }
  })

  it('CONTROL — the same kinds DO produce buttons with a panel', () => {
    for (const kind of ['alarm-triggered', 'alarm-armed', 'alarm-disarmed'] as const) {
      expect(buildAlarmButtons({ kind, panel: PANEL, mintUrl, labels }).length).toBeGreaterThan(0)
    }
  })
})
