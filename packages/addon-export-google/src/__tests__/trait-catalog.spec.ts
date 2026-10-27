import { describe, expect, it } from 'vitest'

import {
  type CommandResolution,
  statesAfterCall,
  TRAIT_CATALOG,
  traitForCommand,
  traitsForCaps,
} from '../google-home/trait-catalog.js'

/**
 * The invariant this whole file exists for: a capability that SYNC declares
 * must also be readable by QUERY and writable by EXECUTE.
 *
 * This is the check that the three-file Alexa shape cannot express, and the
 * one the repo has already been bitten by from the other direction — see the
 * docblock on `scripts/check-export-coverage.ts`.
 */
describe('trait catalog invariants', () => {
  it('declares every row with a read path and at least one command', () => {
    expect(TRAIT_CATALOG.length).toBeGreaterThan(0)
    for (const row of TRAIT_CATALOG) {
      expect(row.capName.length, `${row.trait} capName`).toBeGreaterThan(0)
      expect(row.reads.length, `${row.trait} reads`).toBeGreaterThan(0)
      expect(row.commands.length, `${row.trait} commands`).toBeGreaterThan(0)
    }
  })

  it('answers every command it advertises', () => {
    for (const row of TRAIT_CATALOG) {
      for (const command of row.commands) {
        const resolution = row.resolveCommand({
          deviceId: 1,
          command,
          // Deliberately empty params: the row must recognise the command and
          // refuse on the PARAMS, never with `functionNotSupported`, which is
          // what "I do not answer this command" means.
          params: {},
          features: [],
        })
        expect(resolution.kind, `${row.trait} ${command}`).toBe('refused')
        if (resolution.kind === 'refused') {
          expect(resolution.errorCode, `${row.trait} ${command}`).not.toBe('functionNotSupported')
        }
      }
    }
  })

  it('has one row per capability name', () => {
    const names = TRAIT_CATALOG.map((row) => row.capName)
    expect(new Set(names).size).toBe(names.length)
  })

  it('rejects a status payload that is not the cap shape', () => {
    for (const row of TRAIT_CATALOG) {
      expect(row.projectState(null), `${row.trait} null`).toBeNull()
      expect(row.projectState({ nonsense: true }), `${row.trait} junk`).toBeNull()
    }
  })
})

describe('traitsForCaps', () => {
  it('returns rows in catalog order regardless of binding order', () => {
    const rows = traitsForCaps(['cover', 'switch', 'brightness'])
    expect(rows.map((r) => r.capName)).toEqual(['switch', 'brightness', 'cover'])
  })

  it('ignores capabilities the catalog does not cover', () => {
    expect(traitsForCaps(['camera-streams', 'snapshot', 'ptz'])).toEqual([])
  })
})

describe('traitForCommand', () => {
  it('resolves a command only through a capability the device actually has', () => {
    expect(traitForCommand(['switch'], 'action.devices.commands.OnOff')?.capName).toBe('switch')
    expect(traitForCommand(['switch'], 'action.devices.commands.LockUnlock')).toBeNull()
  })
})

// ── Per-trait behaviour ─────────────────────────────────────────────

function resolve(
  capNames: readonly string[],
  command: string,
  params: Record<string, unknown>,
  features: readonly string[] = [],
): CommandResolution {
  const row = traitForCommand(capNames, command)
  if (row === null) throw new Error(`no row answers ${command}`)
  return row.resolveCommand({ deviceId: 7, command, params, features })
}

describe('OnOff', () => {
  it('projects the switch slice', () => {
    const row = traitsForCaps(['switch'])[0]
    expect(row?.projectState({ on: true, lastChangedAt: 1 })).toEqual({ on: true })
  })

  it('routes OnOff to switch.setState', () => {
    expect(resolve(['switch'], 'action.devices.commands.OnOff', { on: false })).toEqual({
      kind: 'call',
      call: { kind: 'switch.setState', deviceId: 7, on: false },
    })
  })

  it('refuses a non-boolean on param instead of guessing', () => {
    const resolution = resolve(['switch'], 'action.devices.commands.OnOff', { on: 'yes' })
    expect(resolution.kind).toBe('refused')
  })
})

describe('Brightness', () => {
  it('rounds the cap percentage to Google’s integer scale', () => {
    const row = traitsForCaps(['brightness'])[0]
    expect(row?.projectState({ level: 42.6, lastChangedAt: 1 })).toEqual({ brightness: 43 })
  })

  it('routes BrightnessAbsolute to brightness.setBrightness', () => {
    expect(
      resolve(['brightness'], 'action.devices.commands.BrightnessAbsolute', { brightness: 30 }),
    ).toEqual({
      kind: 'call',
      call: { kind: 'brightness.setBrightness', deviceId: 7, percentage: 30 },
    })
  })

  it('refuses an out-of-range brightness', () => {
    const resolution = resolve(['brightness'], 'action.devices.commands.BrightnessAbsolute', {
      brightness: 140,
    })
    expect(resolution).toMatchObject({ kind: 'refused', errorCode: 'valueOutOfRange' })
  })
})

describe('LockUnlock', () => {
  it('reports the stable state, never the in-transit target', () => {
    const row = traitsForCaps(['lock-control'])[0]
    expect(row?.projectState({ state: 'locked', lastChangedAt: 1 })).toEqual({
      isLocked: true,
      isJammed: false,
    })
    // `locking` is NOT locked yet — reporting the target here is what makes a
    // failed motor look like a successful lock.
    expect(row?.projectState({ state: 'locking', lastChangedAt: 1 })).toEqual({
      isLocked: false,
      isJammed: false,
    })
    expect(row?.projectState({ state: 'jammed', lastChangedAt: 1 })).toEqual({
      isLocked: false,
      isJammed: true,
    })
  })

  it('routes lock and unlock to different cap methods', () => {
    expect(resolve(['lock-control'], 'action.devices.commands.LockUnlock', { lock: true })).toEqual(
      {
        kind: 'call',
        call: { kind: 'lockControl.lock', deviceId: 7 },
      },
    )
    expect(
      resolve(['lock-control'], 'action.devices.commands.LockUnlock', { lock: false }),
    ).toEqual({ kind: 'call', call: { kind: 'lockControl.unlock', deviceId: 7 } })
  })

  it('refuses a PIN-required lock, because Google sends no PIN', () => {
    const resolution = resolve(
      ['lock-control'],
      'action.devices.commands.LockUnlock',
      { lock: true },
      ['lock-pin-required'],
    )
    expect(resolution).toMatchObject({ kind: 'refused', errorCode: 'functionNotSupported' })
  })
})

describe('OpenClose', () => {
  it('reports the position when the cover has one', () => {
    const row = traitsForCaps(['cover'])[0]
    expect(
      row?.projectState({ state: 'open', position: 35, tiltPosition: null, lastChangedAt: 1 }),
    ).toEqual({ openPercent: 35 })
  })

  it('collapses a positionless cover to Google’s two values', () => {
    const row = traitsForCaps(['cover'])[0]
    expect(
      row?.projectState({ state: 'closed', position: null, tiltPosition: null, lastChangedAt: 1 }),
    ).toEqual({ openPercent: 0 })
    expect(
      row?.projectState({ state: 'stopped', position: null, tiltPosition: null, lastChangedAt: 1 }),
    ).toEqual({ openPercent: 100 })
  })

  it('marks a non-positionable cover discreteOnly so Google renders buttons', () => {
    const row = traitsForCaps(['cover'])[0]
    expect(row?.attributes([])).toEqual({ discreteOnlyOpenClose: true })
    expect(row?.attributes(['cover-positionable'])).toEqual({ discreteOnlyOpenClose: false })
  })

  it('uses setPosition only when the cover is positionable', () => {
    expect(
      resolve(['cover'], 'action.devices.commands.OpenClose', { openPercent: 40 }, [
        'cover-positionable',
      ]),
    ).toEqual({ kind: 'call', call: { kind: 'cover.setPosition', deviceId: 7, position: 40 } })

    expect(resolve(['cover'], 'action.devices.commands.OpenClose', { openPercent: 40 })).toEqual({
      kind: 'call',
      call: { kind: 'cover.open', deviceId: 7 },
    })
    expect(resolve(['cover'], 'action.devices.commands.OpenClose', { openPercent: 0 })).toEqual({
      kind: 'call',
      call: { kind: 'cover.close', deviceId: 7 },
    })
  })

  it('refuses a relative move rather than inventing the current position', () => {
    const resolution = resolve(['cover'], 'action.devices.commands.OpenClose', {
      openRelativePercent: 10,
    })
    expect(resolution).toMatchObject({ kind: 'refused', errorCode: 'functionNotSupported' })
  })
})

describe('statesAfterCall', () => {
  it('echoes the state each call establishes', () => {
    expect(statesAfterCall({ kind: 'switch.setState', deviceId: 1, on: true })).toEqual({
      on: true,
    })
    expect(statesAfterCall({ kind: 'lockControl.lock', deviceId: 1 })).toEqual({
      isLocked: true,
      isJammed: false,
    })
    expect(statesAfterCall({ kind: 'cover.setPosition', deviceId: 1, position: 12 })).toEqual({
      openPercent: 12,
    })
  })
})
