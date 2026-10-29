/**
 * `forward` commands of a BUILT capability (D659, amended by D967): the
 * validator accepts a built cap only when every served method has a command,
 * checks the source cap and method, and refuses an unknown input field BY NAME.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { method, type CapabilityDefinition } from '../../capabilities/capability-definition.js'
import { consumablesCapability } from '../../capabilities/consumables.cap.js'
import { DeviceType } from '../../device/device-type.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import {
  buildCapabilityLookup,
  type Composition,
  CompositionSchema,
  type CompositionSourceDescription,
  type CompositionSourceRef,
  compositionSourceKey,
  compositionSourceRefs,
  planComposition,
  validateComposition,
} from '../index.js'

const DEVICE_ID = z.number().int().nonnegative()

const fountainCap = {
  name: 'forward-test-fountain',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.PetFeeder],
  methods: {
    setPump: method(z.object({ deviceId: DEVICE_ID, on: z.boolean() }), z.void(), {
      kind: 'mutation',
    }),
    setTiming: method(z.object({ deviceId: DEVICE_ID, minutes: z.number() }), z.void(), {
      kind: 'mutation',
    }),
    flush: method(z.object({ deviceId: DEVICE_ID }), z.void(), { kind: 'mutation' }),
  },
  status: {
    schema: z.object({ pumpOn: z.boolean().nullable(), lastFetchedAt: z.number() }),
    kind: 'poll',
  },
  runtimeState: z.object({ pumpOn: z.boolean().nullable(), lastFetchedAt: z.number() }),
  durability: 'session',
  history: 'none',
} as const satisfies CapabilityDefinition

/** A source cap with a QUERY: a command never calls one. */
const readerCap = {
  name: 'forward-test-reader',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  methods: {
    peek: method(z.object({ deviceId: DEVICE_ID }), z.number(), { kind: 'query' }),
  },
  durability: 'session',
  history: 'none',
} as const satisfies CapabilityDefinition

const lookup = buildCapabilityLookup([...ALL_CAPABILITY_DEFINITIONS, fountainCap, readerCap])

const NOW = { kind: 'expression', expr: 'now', bindings: {} }
const PUMP: CompositionSourceRef = { addonId: 'homeassistant', stableId: 'switch.pump' }
const BUTTON: CompositionSourceRef = { addonId: 'homeassistant', stableId: 'button.flush' }
const NUMBER: CompositionSourceRef = { addonId: 'homeassistant', stableId: 'number.on_minutes' }

function composition(commands: unknown, extraFields: Record<string, unknown> = {}): Composition {
  return CompositionSchema.parse({
    target: { kind: 'new', type: DeviceType.PetFeeder },
    features: [
      {
        kind: 'fields',
        cap: fountainCap.name,
        fields: {
          pumpOn: { kind: 'from', source: PUMP, cap: 'switch', fieldPath: 'on' },
          lastFetchedAt: NOW,
          ...extraFields,
        },
        commands,
      },
    ],
  })
}

const GOOD_COMMANDS = {
  setPump: { kind: 'forward', source: PUMP, cap: 'switch', method: 'setState' },
  setTiming: {
    kind: 'forward',
    source: NUMBER,
    cap: 'control',
    method: 'setValue',
    args: { control: { kind: 'numeric', value: { $input: 'minutes' } } },
  },
  flush: { kind: 'forward', source: BUTTON, cap: 'button', method: 'press' },
}

function codes(c: Composition): string[] {
  return planComposition(c, lookup).problems.map((p) => p.code)
}

function sources(
  caps: Record<string, readonly string[]>,
): Map<string, CompositionSourceDescription> {
  return new Map(
    [PUMP, BUTTON, NUMBER].map((ref, i) => [
      compositionSourceKey(ref),
      { kind: 'found', deviceId: 10 + i, caps: new Set(caps[ref.stableId] ?? []) },
    ]),
  )
}

const REAL = {
  'switch.pump': ['switch'],
  'button.flush': ['button'],
  'number.on_minutes': ['control'],
}

function validate(c: Composition, described = sources(REAL)) {
  return validateComposition(c, {
    lookupCap: lookup,
    sources: described,
    self: null,
    blockId: null,
    target: null,
    peers: [],
  })
}

describe('forward commands on a built capability', () => {
  it('accepts a built cap when every served method has a forward', () => {
    expect(planComposition(composition(GOOD_COMMANDS), lookup).problems).toEqual([])
  })

  it('refuses a built cap with a method that has no command, naming the method', () => {
    const { flush: _flush, ...partial } = GOOD_COMMANDS
    const result = planComposition(composition(partial), lookup)
    expect(result.problems.map((p) => p.code)).toEqual(['has-commands'])
    expect(result.problems[0]?.message).toContain('flush')
  })

  it('refuses a command for a method the cap does not serve', () => {
    const result = planComposition(
      composition({
        ...GOOD_COMMANDS,
        explode: { kind: 'forward', source: BUTTON, cap: 'button', method: 'press' },
      }),
      lookup,
    )
    expect(result.problems.map((p) => p.code)).toEqual(['command-method-unknown'])
  })

  it('refuses a forward to a capability or method that does not exist', () => {
    expect(
      codes(
        composition({
          ...GOOD_COMMANDS,
          flush: { kind: 'forward', source: BUTTON, cap: 'no-such-cap', method: 'press' },
        }),
      ),
    ).toEqual(['command-source-unknown'])
    expect(
      codes(
        composition({
          ...GOOD_COMMANDS,
          flush: { kind: 'forward', source: BUTTON, cap: 'button', method: 'smash' },
        }),
      ),
    ).toEqual(['command-source-unknown'])
  })

  it('refuses a forward to a query: a command calls a mutation of the source', () => {
    const result = planComposition(
      composition({
        ...GOOD_COMMANDS,
        flush: { kind: 'forward', source: BUTTON, cap: readerCap.name, method: 'peek' },
      }),
      lookup,
    )
    expect(result.problems.map((p) => p.code)).toEqual(['command-source-unknown'])
    expect(result.problems[0]?.message).toContain('mutation')
  })

  it('without args, refuses an input field the source method does not take, by name', () => {
    const result = planComposition(
      composition({
        ...GOOD_COMMANDS,
        setTiming: { kind: 'forward', source: PUMP, cap: 'switch', method: 'setState' },
      }),
      lookup,
    )
    const unknown = result.problems.filter((p) => p.code === 'command-input-unknown')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.message).toContain('`minutes`')
    // and `on`, which the source requires, is provided by nothing
    expect(result.problems.map((p) => p.code)).toContain('command-input-missing')
  })

  it('with args, refuses an unknown source field and an unknown $input, by name', () => {
    const wrongKey = planComposition(
      composition({
        ...GOOD_COMMANDS,
        setPump: {
          kind: 'forward',
          source: PUMP,
          cap: 'switch',
          method: 'setState',
          args: { on: { $input: 'on' }, speed: 3 },
        },
      }),
      lookup,
    )
    expect(wrongKey.problems.map((p) => [p.code, p.path])).toEqual([
      ['command-input-unknown', 'features[0].commands.setPump.args.speed'],
    ])
    const wrongRef = planComposition(
      composition({
        ...GOOD_COMMANDS,
        setPump: {
          kind: 'forward',
          source: PUMP,
          cap: 'switch',
          method: 'setState',
          args: { on: { $input: 'enabled' } },
        },
      }),
      lookup,
    )
    expect(wrongRef.problems).toHaveLength(1)
    expect(wrongRef.problems[0]?.message).toContain('`$input: enabled`')
  })

  it('refuses deviceId as an argument: it is the source device own', () => {
    const result = planComposition(
      composition({
        ...GOOD_COMMANDS,
        setPump: {
          kind: 'forward',
          source: PUMP,
          cap: 'switch',
          method: 'setState',
          args: { deviceId: 7, on: true },
        },
      }),
      lookup,
    )
    expect(result.problems.map((p) => p.code)).toEqual(['command-input-unknown'])
  })

  it('a constant args template needs no $input', () => {
    const result = planComposition(
      composition({
        ...GOOD_COMMANDS,
        setPump: {
          kind: 'forward',
          source: PUMP,
          cap: 'switch',
          method: 'setState',
          args: { on: true },
        },
      }),
      lookup,
    )
    expect(result.problems).toEqual([])
  })

  it('keeps a code command and a passthrough feature reserved', () => {
    expect(
      codes(
        composition({
          ...GOOD_COMMANDS,
          flush: { kind: 'code', code: 'return 1' },
        }),
      ),
    ).toContain('has-commands')
  })

  it('refuses commands on an existing device: only a built cap takes them', () => {
    const onExisting = CompositionSchema.parse({
      target: { kind: 'existing', device: { addonId: 'homeassistant', stableId: 'container' } },
      features: [
        {
          kind: 'fields',
          cap: fountainCap.name,
          fields: {
            pumpOn: { kind: 'from', source: PUMP, cap: 'switch', fieldPath: 'on' },
            lastFetchedAt: NOW,
          },
          commands: GOOD_COMMANDS,
        },
      ],
    })
    const result = planComposition(onExisting, lookup, {
      kind: 'found',
      deviceId: 50,
      type: DeviceType.PetFeeder,
      nativeCaps: new Map(),
    })
    expect(result.problems.map((p) => p.code)).toContain('reserved-variant')
  })
})

describe('forward sources, read from the hub', () => {
  it('lists the forward sources among the sources a save must read', () => {
    const keys = compositionSourceRefs(composition(GOOD_COMMANDS)).map(compositionSourceKey)
    expect(keys).toContain(compositionSourceKey(BUTTON))
    expect(keys).toContain(compositionSourceKey(NUMBER))
  })

  it('accepts sources that exist and bind the called cap', () => {
    expect(validate(composition(GOOD_COMMANDS)).problems).toEqual([])
  })

  it('refuses a source device that lacks the called cap, at the command', () => {
    const result = validate(composition(GOOD_COMMANDS), sources({ ...REAL, 'button.flush': [] }))
    expect(result.problems.map((p) => [p.code, p.path])).toEqual([
      ['source-capability-missing', 'features[0].commands.flush.source'],
    ])
  })

  it('refuses a forward source that was not read or does not exist', () => {
    const described = sources(REAL)
    described.delete(compositionSourceKey(BUTTON))
    expect(validate(composition(GOOD_COMMANDS), described).problems.map((p) => p.code)).toEqual([
      'source-unreadable',
    ])
    described.set(compositionSourceKey(BUTTON), { kind: 'absent' })
    expect(validate(composition(GOOD_COMMANDS), described).problems.map((p) => p.code)).toEqual([
      'source-missing',
    ])
  })
})

describe('an item reset forward (consumables)', () => {
  function withItem(item: Record<string, unknown>): Composition {
    return CompositionSchema.parse({
      target: { kind: 'new', type: DeviceType.PetFeeder },
      features: [
        {
          kind: 'fields',
          cap: consumablesCapability.name,
          fields: { lastChangedAt: NOW, lastFetchedAt: NOW },
          items: {
            filter: {
              label: 'Filter',
              fields: { lastResetAt: NOW },
              ...item,
            },
          },
        },
      ],
    })
  }

  it('a reset forward makes the item resettable in the plan', () => {
    const result = planComposition(
      withItem({ reset: { kind: 'forward', source: BUTTON, cap: 'button', method: 'press' } }),
      lookup,
    )
    const itemFields = result.fields.filter((f) => f.item !== undefined)
    expect(itemFields.length).toBeGreaterThan(0)
    expect(itemFields.every((f) => f.item?.resettable === true)).toBe(true)
  })

  it('an item without a reset forward is not resettable', () => {
    const result = planComposition(withItem({}), lookup)
    const itemFields = result.fields.filter((f) => f.item !== undefined)
    expect(itemFields.length).toBeGreaterThan(0)
    expect(itemFields.every((f) => f.item?.resettable !== true)).toBe(true)
  })

  it('a reset forward is checked against the source method: reset takes no input', () => {
    const result = planComposition(
      withItem({ reset: { kind: 'forward', source: PUMP, cap: 'switch', method: 'setState' } }),
      lookup,
    )
    expect(result.problems.map((p) => p.code)).toContain('command-input-missing')
  })

  it('lists the reset source among the sources a save must read', () => {
    const keys = compositionSourceRefs(
      withItem({ reset: { kind: 'forward', source: BUTTON, cap: 'button', method: 'press' } }),
    ).map(compositionSourceKey)
    expect(keys).toContain(compositionSourceKey(BUTTON))
  })
})
