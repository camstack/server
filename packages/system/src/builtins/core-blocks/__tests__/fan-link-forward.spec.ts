/**
 * The Dreo studio fan (3370) with its axes linked in Customize to the HA
 * siblings production has (D1034): swing switches 3361/3362, numeric controls
 * 3364–3369, the 3D preset select 3375. A write to a linked field goes to the
 * link; a field nobody linked stays the native provider's.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CompositionSourceRef, CoreBlock, IScopedLogger } from '@camstack/types'
import {
  type FanLinkForwardPorts,
  fanLinkForwardRedirect,
  type LinkedControlReading,
} from '../fan-link-forward.js'

const ha = (stableId: string): CompositionSourceRef => ({ addonId: 'homeassistant', stableId })
const IDS: Readonly<Record<string, number>> = {
  'fan.studio': 3370,
  'switch.studio_h_swing': 3361,
  'switch.studio_v_swing': 3362,
  'number.studio_h_angle': 3364,
  'number.studio_h_sweep_from': 3365,
  'number.studio_h_sweep_to': 3366,
  'number.studio_v_angle': 3367,
  'select.studio_preset_3d': 3375,
}
const from = (stableId: string, cap: string, fieldPath: string) => ({
  kind: 'from' as const,
  source: ha(stableId),
  cap,
  fieldPath,
})

const BLOCK: Pick<CoreBlock, 'source'> = {
  source: {
    kind: 'composition',
    composition: {
      target: { kind: 'existing', device: ha('fan.studio') },
      features: [
        {
          kind: 'fields',
          cap: 'fan-control',
          fields: {
            'oscillationAxes.horizontal.oscillating': from('switch.studio_h_swing', 'switch', 'on'),
            'oscillationAxes.horizontal.angle': from('number.studio_h_angle', 'control', 'value'),
            'oscillationAxes.horizontal.min': from('number.studio_h_angle', 'control', 'min'),
            'oscillationAxes.horizontal.max': from('number.studio_h_angle', 'control', 'max'),
            preset: from('select.studio_preset_3d', 'control', 'value'),
          },
        },
      ],
    },
  },
}

const CONTROLS: Readonly<Record<number, LinkedControlReading>> = {
  3364: { kind: 'numeric', options: [], min: 0, max: 120 },
  3375: { kind: 'select', options: ['Off', 'Preset 1', 'Preset 2'] },
}

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

function harness(overrides: Partial<FanLinkForwardPorts> = {}) {
  const setSwitch = vi.fn(async (_id: number, _on: boolean) => undefined)
  const setControl = vi.fn(async (_id: number, _c: unknown) => undefined)
  const ports: FanLinkForwardPorts = {
    blocks: () => [BLOCK],
    find: async (ref) => {
      const id = IDS[ref.stableId]
      return id === undefined ? null : { id, name: ref.stableId }
    },
    readControl: async (id) => CONTROLS[id] ?? null,
    setSwitch,
    setControl,
    logger: logger(),
    ...overrides,
  }
  return { redirect: fanLinkForwardRedirect(ports), setSwitch, setControl, ports }
}

const axisCall = (args: Record<string, unknown>) => ({
  capName: 'fan-control',
  method: 'setOscillationAxis',
  deviceId: 3370,
  args: { deviceId: 3370, ...args },
})

describe('setOscillationAxis on a linked fan', () => {
  it('covers only the fan-control writes it can forward', () => {
    const { redirect } = harness()
    expect(redirect.covers('fan-control', 'setOscillationAxis')).toBe(true)
    expect(redirect.covers('fan-control', 'setPreset')).toBe(true)
    expect(redirect.covers('fan-control', 'setPercentage')).toBe(false)
    expect(redirect.covers('switch', 'setState')).toBe(false)
  })

  it('switches the swing switch 3361 and sets the angle control 3364, in order', async () => {
    const { redirect, setSwitch, setControl } = harness()
    const answer = await redirect.attempt(
      axisCall({ axis: 'horizontal', oscillating: false, angle: 45 }),
    )
    expect(answer).toEqual({ kind: 'redirected', result: { status: 'applied' } })
    expect(setSwitch).toHaveBeenCalledWith(3361, false)
    expect(setControl).toHaveBeenCalledWith(3364, { kind: 'numeric', value: 45 })
  })

  it('refuses an angle outside the control range, after what already landed', async () => {
    const { redirect, setControl } = harness()
    const answer = await redirect.attempt(
      axisCall({ axis: 'horizontal', oscillating: true, angle: 180 }),
    )
    expect(answer).toMatchObject({
      kind: 'redirected',
      result: {
        status: 'refused',
        reason: 'out-of-range',
        field: 'angle',
        applied: ['oscillating'],
      },
    })
    expect(setControl).not.toHaveBeenCalled()
  })

  it('a call naming no linked field is the native provider’s', async () => {
    const { redirect } = harness()
    expect(await redirect.attempt(axisCall({ axis: 'vertical', oscillating: true }))).toEqual({
      kind: 'not-redirected',
    })
  })

  it('refuses a field nobody linked when the call also names a linked one', async () => {
    const { redirect } = harness()
    const answer = await redirect.attempt(axisCall({ axis: 'horizontal', angle: 30, sweepTo: 90 }))
    expect(answer).toMatchObject({
      result: {
        status: 'refused',
        reason: 'axis-not-linked',
        field: 'sweepTo',
        applied: ['angle'],
      },
    })
  })

  it('refuses nothing-to-set', async () => {
    const { redirect } = harness()
    expect(await redirect.attempt(axisCall({ axis: 'horizontal' }))).toMatchObject({
      result: { status: 'refused', reason: 'nothing-to-set' },
    })
  })

  it('a linked switch that is gone refuses source-gone, naming it', async () => {
    const { redirect } = harness({
      find: async (ref) =>
        ref.stableId === 'switch.studio_h_swing' ? null : { id: IDS[ref.stableId] ?? 0, name: '' },
    })
    const answer = await redirect.attempt(axisCall({ axis: 'horizontal', oscillating: true }))
    expect(answer).toMatchObject({ result: { status: 'refused', reason: 'source-gone' } })
    expect(JSON.stringify(answer)).toContain('switch.studio_h_swing')
  })

  it('a device call that is not the linked fan is not redirected', async () => {
    const { redirect } = harness()
    const answer = await redirect.attempt({
      ...axisCall({ axis: 'horizontal', angle: 10 }),
      deviceId: 9,
    })
    expect(answer).toEqual({ kind: 'not-redirected' })
  })
})

describe('setPreset on a fan whose preset is linked to the select 3375', () => {
  const presetCall = (preset: string) => ({
    capName: 'fan-control',
    method: 'setPreset',
    deviceId: 3370,
    args: { deviceId: 3370, preset },
  })

  it('selects a live option on the select', async () => {
    const { redirect, setControl } = harness()
    expect(await redirect.attempt(presetCall('Preset 2'))).toEqual({
      kind: 'redirected',
      result: undefined,
    })
    expect(setControl).toHaveBeenCalledWith(3375, { kind: 'select', value: 'Preset 2' })
  })

  it('refuses a preset the select does not offer NOW, as out-of-range', async () => {
    const { redirect, setControl } = harness()
    await expect(redirect.attempt(presetCall('turbo'))).rejects.toThrow(/out-of-range/)
    expect(setControl).not.toHaveBeenCalled()
  })
})
