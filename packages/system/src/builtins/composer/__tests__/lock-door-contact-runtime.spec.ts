/**
 * The lock's door-contact override (D984) through the REAL runtime: the lock's
 * `state` is a replaced field whose value is derived from the contact's RAW
 * `entryOpen` and the lock's NATIVE state. The composer writes it into the
 * claimed slice the hub mirrors, so every reader sees `door-open`.
 */
import {
  CompositionSchema,
  compileScalarOverride,
  compositionReadKey,
  compositionSliceKey,
  DeviceType,
  planComposition,
  type CompositionSourceRef,
  type SourceReading,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { CompositionRuntime } from '../composition-runtime.js'
import { FakeTarget, FakeTimer, LOOKUP_CAP, recordingLogger } from './fixtures.js'

const LOCK: CompositionSourceRef = {
  addonId: 'provider-x',
  stableId: 'lock-1',
}
const DOOR: CompositionSourceRef = {
  addonId: 'provider-x',
  stableId: 'door-1',
}
const fresh = (value: string | boolean): SourceReading => ({
  state: 'fresh',
  value,
})
/** A CONFIRMED unavailability is the only kind that hands the field back to the native. */
const UNREACHABLE: SourceReading = {
  state: 'unavailable',
  reason: 'offline',
  fatal: false,
  confirmed: true,
}
const UNKNOWN: SourceReading = { state: 'unavailable', reason: 'not read yet', fatal: false }

function plan() {
  const compiled = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'lock-control',
      targetId: 'door-contact',
      source: { ...DOOR, cap: 'contact', fieldPath: 'entryOpen' },
      transform: { kind: 'identity' },
    },
    device: LOCK,
    apply: 'replace',
    sourceValueKind: 'boolean',
    changedAtField: null,
    sourceUnit: null,
  })
  if (!compiled.ok) throw new Error(compiled.reason)
  const composition = CompositionSchema.parse({
    target: { kind: 'existing', device: LOCK },
    features: [compiled.value],
  })
  const planned = planComposition(composition, LOOKUP_CAP, {
    kind: 'found',
    deviceId: 77,
    type: DeviceType.Lock,
    nativeCaps: new Map([['lock-control', 'provider-x']]),
  })
  if (planned.problems.length > 0)
    throw new Error(planned.problems.map((p) => p.message).join('; '))
  return planned.fields
}

const CONTACT_KEY = compositionReadKey({
  source: DOOR,
  cap: 'contact',
  fieldPath: 'entryOpen',
})
const NATIVE_KEY = compositionReadKey({
  source: LOCK,
  cap: 'lock-control',
  fieldPath: 'state',
})

let readings: Map<string, SourceReading>
let target: FakeTarget
let runtime: CompositionRuntime

beforeEach(() => {
  readings = new Map()
  target = new FakeTarget(77)
  runtime = new CompositionRuntime({
    blockId: 'b-lock',
    fields: plan(),
    eventPlans: [],
    events: { emit: () => undefined },
    target,
    lookupCap: LOOKUP_CAP,
    read: (r) =>
      readings.get(compositionReadKey(r)) ?? {
        state: 'unavailable',
        reason: 'none',
        fatal: false,
      },
    now: () => 1_000_000,
    timer: new FakeTimer(),
    logger: recordingLogger().logger,
  })
})

const lastState = () =>
  target.writes
    .filter((w) => w.cap === 'lock-control')
    .map((w) => w.values['state'])
    .filter((v) => v !== undefined)
    .at(-1)

function drive(native: string, contact: SourceReading) {
  readings.set(NATIVE_KEY, fresh(native))
  readings.set(CONTACT_KEY, contact)
  runtime.start()
}

describe('door-contact override reaches the written slice', () => {
  it('a locked lock with the door open reports door-open', () => {
    drive('locked', fresh(true))
    expect(lastState()).toBe('door-open')
  })

  it('a native jammed wins over an open door', () => {
    drive('jammed', fresh(true))
    expect(lastState()).toBe('jammed')
  })

  it('a closed door leaves the native state', () => {
    drive('locked', fresh(false))
    expect(lastState()).toBe('locked')
  })

  it('an unreadable contact does not write door-open — the field is handed back to native', () => {
    drive('locked', UNREACHABLE)
    expect(lastState()).not.toBe('door-open')
    expect(
      target.withholds.some((w) => w.cap === 'lock-control' && w.fields.includes('state')),
    ).toBe(true)
  })

  it('an unknown (not yet read) contact never reports door-open', () => {
    drive('locked', UNKNOWN)
    expect(lastState()).not.toBe('door-open')
  })

  it('closing the door re-emits the native state', () => {
    drive('locked', fresh(true))
    readings.set(CONTACT_KEY, fresh(false))
    runtime.onSourcesChanged(new Set([compositionSliceKey(DOOR, 'contact')]))
    expect(lastState()).toBe('locked')
  })
})
