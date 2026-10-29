/**
 * The runtime of `forward` commands (D967): mapping, source resolution and the
 * typed refusal that names the source.
 */
import { type CompositionFieldsFeature, CompositionSchema, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ForwardCommands, ForwardRefusedError, forwardArguments } from '../forward-commands.js'
import type { SourceResolution } from '../source-readings.js'
import { recordingLogger } from './fixtures.js'

const COMPOSED_ID = 900
const NOW = { kind: 'expression', expr: 'now', bindings: {} }
const PUMP = { addonId: 'homeassistant', stableId: 'switch.pump' }
const MINUTES = { addonId: 'homeassistant', stableId: 'number.on_minutes' }
const FILTER_BUTTON = { addonId: 'homeassistant', stableId: 'button.filter_changed' }

function features(): readonly CompositionFieldsFeature[] {
  const composition = CompositionSchema.parse({
    target: { kind: 'new', type: DeviceType.PetFeeder },
    features: [
      {
        kind: 'fields',
        cap: 'pump-test',
        fields: { lastFetchedAt: NOW },
        commands: {
          setPump: { kind: 'forward', source: PUMP, cap: 'switch', method: 'setState' },
          setOnMinutes: {
            kind: 'forward',
            source: MINUTES,
            cap: 'control',
            method: 'setValue',
            args: { control: { kind: 'numeric', value: { $input: 'minutes' } } },
          },
        },
      },
      {
        kind: 'fields',
        cap: 'consumables',
        fields: { lastChangedAt: NOW, lastFetchedAt: NOW },
        items: {
          filter: {
            label: 'Filter',
            fields: { status: { kind: 'expression', expr: '"ok"', bindings: {} } },
            reset: { kind: 'forward', source: FILTER_BUTTON, cap: 'button', method: 'press' },
          },
        },
      },
    ],
  })
  return composition.features.flatMap((f) => (f.kind === 'fields' ? [f] : []))
}

interface Call {
  readonly deviceId: number
  readonly cap: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
}

function world(options: {
  readonly resolution?: (stableId: string) => SourceResolution
  readonly failWith?: string
}) {
  const calls: Call[] = []
  const recorded = recordingLogger()
  const forwards = new ForwardCommands({
    logger: recorded.logger,
    resolve: async (ref) =>
      options.resolution?.(ref.stableId) ?? {
        kind: 'found',
        deviceId: 77,
        type: DeviceType.Switch,
      },
    callCapMethod: async (deviceId, cap, method, args) => {
      if (options.failWith !== undefined) throw new Error(options.failWith)
      calls.push({ deviceId, cap, method, args })
    },
    deviceIdOf: (blockId) => (blockId === 'fountain' ? COMPOSED_ID : null),
  })
  forwards.sync([{ id: 'fountain', features: features() }])
  return { forwards, calls, lines: recorded.lines }
}

const dispatch = (cap: string, method: string, args: Readonly<Record<string, unknown>>) => ({
  groupDeviceId: COMPOSED_ID,
  cap,
  method,
  args,
})

describe('forwardArguments', () => {
  const passThrough = { kind: 'forward', source: PUMP, cap: 'switch', method: 'setState' } as const

  it('passes the input through without deviceId and without undefined fields', () => {
    expect(forwardArguments(passThrough, { deviceId: 9, on: true, extra: undefined })).toEqual({
      on: true,
    })
  })

  it('substitutes $input at any depth and sends constants as they are', () => {
    expect(
      forwardArguments(
        {
          ...passThrough,
          args: { control: { kind: 'numeric', value: { $input: 'minutes' } }, fixed: 3 },
        },
        { minutes: 12 },
      ),
    ).toEqual({ control: { kind: 'numeric', value: 12 }, fixed: 3 })
  })

  it('leaves out a key whose $input the caller did not send', () => {
    expect(forwardArguments({ ...passThrough, args: { on: { $input: 'on' } } }, {})).toEqual({})
  })
})

describe('ForwardCommands', () => {
  it('serves only the devices that have forwards', () => {
    const { forwards } = world({})
    expect(forwards.serves(COMPOSED_ID)).toBe(true)
    expect(forwards.serves(1)).toBe(false)
  })

  it('forwards a method to the resolved source device with the source deviceId', async () => {
    const { forwards, calls } = world({})
    await forwards.command(dispatch('pump-test', 'setPump', { on: true }))
    expect(calls).toEqual([{ deviceId: 77, cap: 'switch', method: 'setState', args: { on: true } }])
  })

  it('maps the input through args', async () => {
    const { forwards, calls } = world({})
    await forwards.command(dispatch('pump-test', 'setOnMinutes', { minutes: 20 }))
    expect(calls).toEqual([
      {
        deviceId: 77,
        cap: 'control',
        method: 'setValue',
        args: { control: { kind: 'numeric', value: 20 } },
      },
    ])
  })

  it('an item reset is addressed by its key, and the key is not an argument', async () => {
    const { forwards, calls } = world({})
    await forwards.command(dispatch('consumables', 'reset', { key: 'filter' }))
    expect(calls).toEqual([{ deviceId: 77, cap: 'button', method: 'press', args: {} }])
  })

  it('refuses a reset of an item with no command, by name', async () => {
    const { forwards, calls } = world({})
    await expect(
      forwards.command(dispatch('consumables', 'reset', { key: 'desiccant' })),
    ).rejects.toMatchObject({
      reason: 'no-command',
    })
    expect(calls).toEqual([])
  })

  it('a source that is gone fails with source-gone, names the source and logs with the composed device id', async () => {
    const { forwards, calls, lines } = world({
      resolution: () => ({ kind: 'missing', reason: 'no such device' }),
    })
    const failure = await forwards
      .command(dispatch('pump-test', 'setPump', { on: true }))
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(ForwardRefusedError)
    expect(failure).toMatchObject({ reason: 'source-gone', source: 'homeassistant/switch.pump' })
    expect(failure instanceof Error ? failure.message : '').toContain('homeassistant/switch.pump')
    expect(calls).toEqual([])
    const line = lines.find((l) => l.level === 'warn')
    expect(line?.extras?.tags).toEqual({ deviceId: COMPOSED_ID })
    expect(line?.extras?.meta).toMatchObject({
      source: 'homeassistant/switch.pump',
      reason: 'source-gone',
    })
  })

  it('a source the index could not answer for is source-unknown', async () => {
    const { forwards } = world({ resolution: () => ({ kind: 'unknown', error: 'hub timeout' }) })
    await expect(
      forwards.command(dispatch('pump-test', 'setPump', { on: true })),
    ).rejects.toMatchObject({
      reason: 'source-unknown',
    })
  })

  it('an offline source that rejects the call fails with source-call-failed, naming the source', async () => {
    const { forwards, lines } = world({ failWith: 'device offline' })
    await expect(
      forwards.command(dispatch('pump-test', 'setPump', { on: true })),
    ).rejects.toMatchObject({
      reason: 'source-call-failed',
      source: 'homeassistant/switch.pump',
    })
    expect(lines.some((l) => l.extras?.tags?.deviceId === COMPOSED_ID)).toBe(true)
  })

  it('a method with no command is refused, not silently dropped', async () => {
    const { forwards, lines } = world({})
    await expect(forwards.command(dispatch('pump-test', 'explode', {}))).rejects.toMatchObject({
      reason: 'no-command',
    })
    expect(lines.some((l) => l.message.includes('no command'))).toBe(true)
  })

  it('a sync that drops the block stops serving its device', () => {
    const { forwards } = world({})
    forwards.sync([])
    expect(forwards.serves(COMPOSED_ID)).toBe(false)
  })
})
