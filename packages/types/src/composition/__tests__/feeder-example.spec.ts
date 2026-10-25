/**
 * `feederCustomizationExample` (D663): the slice-2 template validates against
 * the HA feeder as HA REALLY registers it — a `Container` with no native
 * battery, the desiccant and battery-status children as `enum-sensor`, the
 * battery-charging child as `binary` — and adds exactly `battery` and
 * `consumables`. A source read as `numeric-sensor` (what the pre-ruling brief
 * named) is refused: the desiccant child never binds it.
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import {
  buildCapabilityLookup,
  type CompositionSourceDescription,
  compositionSourceKey,
  feederCustomizationExample,
  feederExampleSources,
  validateComposition,
} from '../index.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const SOURCES = feederExampleSources('b1')

function described(caps: Record<string, readonly string[]>) {
  return new Map<string, CompositionSourceDescription>(
    [SOURCES.desiccantDays, SOURCES.batteryStatus, SOURCES.batteryCharging].map((ref, i) => [
      compositionSourceKey(ref),
      { kind: 'found', deviceId: 60 + i, caps: new Set(caps[ref.stableId] ?? []) },
    ]),
  )
}

const REAL_CAPS = {
  [SOURCES.desiccantDays.stableId]: ['enum-sensor'],
  [SOURCES.batteryStatus.stableId]: ['enum-sensor'],
  [SOURCES.batteryCharging.stableId]: ['binary'],
}

function validate(sources: Map<string, CompositionSourceDescription>) {
  return validateComposition(feederCustomizationExample(SOURCES), {
    lookupCap,
    self: SOURCES.feeder,
    blockId: null,
    peers: [],
    sources,
    target: {
      kind: 'found',
      deviceId: 50,
      type: DeviceType.Container,
      nativeCaps: new Map([['device-status', 'provider-homeassistant']]),
    },
  })
}

describe('feederCustomizationExample', () => {
  it('validates against the real HA registrations and ADDS battery and consumables', () => {
    const result = validate(described(REAL_CAPS))
    expect(result.problems).toEqual([])
    expect(new Set(result.fields.map((f) => f.cap))).toEqual(new Set(['battery', 'consumables']))
    expect(result.features?.map((f) => [f.cap, f.mode])).toEqual([
      ['consumables', 'add'],
      ['battery', 'add'],
    ])
  })

  it('is refused if the desiccant child only served numeric-sensor — the source must be what HA registers', () => {
    const result = validate(
      described({ ...REAL_CAPS, [SOURCES.desiccantDays.stableId]: ['numeric-sensor'] }),
    )
    expect(result.problems.map((p) => p.code)).toEqual([
      'source-capability-missing',
      'source-capability-missing',
    ])
  })
})
