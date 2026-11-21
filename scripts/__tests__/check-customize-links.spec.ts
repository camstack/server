/**
 * D1076 — a whole-capability link names a source cap, a slot and a map the caps
 * actually have, and only ever adds. Each case removes one fact from a known-good
 * fixture.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {
  CapabilityCustomizeSpec,
  CustomizeCapLink,
} from '../../packages/types/src/capabilities/customize-spec.ts'
import { DeviceType } from '../../packages/types/src/device/device-type.ts'
import { judgeCustomize, type CustomizeCapView } from '../lib/customize-declaration.ts'
import { customizeApplyViolations } from '../lib/customize-apply.ts'

const heatPump = z.object({ copNow: z.number().nullable() })
const energy = z.object({
  heatPump: z.object({ copNow: z.number().nullable() }).nullable(),
  lastFetchedAt: z.number(),
})
const meter = z.object({
  power: z.number().nullable().meta({ quantity: 'power' }),
  lastFetchedAt: z.number(),
})

function view(link: CustomizeCapLink, capName = 'energy-system'): CustomizeCapView {
  const customize: CapabilityCustomizeSpec = { version: 1, targets: [], links: [link] }
  return {
    capName,
    runtimeState: capName === 'power-meter' ? meter : energy,
    deviceTypes: [DeviceType.Sensor],
    methods: {},
    customize,
    capStates: new Map([
      ['energy-system', energy],
      ['power-meter', meter],
      ['heat-pump-status', heatPump],
    ]),
    vocabularyHas: () => true,
  }
}

const reference: CustomizeCapLink = {
  id: 'heat-pump',
  sourceCap: 'heat-pump-status',
  mode: 'reference',
  slot: 'heatPump',
  apply: 'add',
}

const rules = (link: CustomizeCapLink, capName?: string) =>
  judgeCustomize(view(link, capName)).map((v) => v.rule)

describe('customize links (D1076)', () => {
  it('accepts a reference link to a nullable object slot', () => {
    expect(rules(reference)).toEqual([])
  })
  it('refuses a source cap that is no cap', () => {
    expect(rules({ ...reference, sourceCap: 'nope' })).toContain('unknown-link-source-cap')
  })
  it('refuses a slot that is not a nullable object', () => {
    expect(rules({ ...reference, slot: 'lastFetchedAt' })).toContain('bad-link-slot')
    expect(rules({ ...reference, slot: undefined })).toContain('bad-link-slot')
  })
  it('refuses a map on a reference link', () => {
    expect(rules({ ...reference, map: { heatPump: 'copNow' } })).toContain('bad-link-map')
  })
  it('refuses a project link to another cap without a map', () => {
    const project: CustomizeCapLink = {
      id: 'meter-device',
      sourceCap: 'heat-pump-status',
      mode: 'project',
      apply: 'add',
    }
    expect(rules(project, 'power-meter')).toContain('bad-link-project')
  })
  it('accepts a same-cap project link and refuses a map whose quantities disagree', () => {
    const project: CustomizeCapLink = {
      id: 'meter-device',
      sourceCap: 'power-meter',
      mode: 'project',
      apply: 'add',
    }
    expect(rules(project, 'power-meter')).toEqual([])
    expect(rules({ ...project, map: { power: 'lastFetchedAt' } }, 'power-meter')).toContain(
      'bad-link-map',
    )
  })
  it('refuses a duplicated link id', () => {
    const doubled = view(reference)
    const found = judgeCustomize({
      ...doubled,
      customize: { version: 1, targets: [], links: [reference, reference] },
    })
    expect(found.map((v) => v.rule)).toContain('duplicate-link')
  })
  it('refuses an apply that is not add, in the declaration and in the apply guard', () => {
    const replacing = { ...reference, apply: 'replace' }
    expect(
      judgeCustomize({
        ...view(reference),
        customize: { version: 1, targets: [], links: [{ ...reference, apply: 'add' }] },
      }),
    ).toEqual([])
    expect(
      customizeApplyViolations([{ capName: 'energy-system', targets: [], links: [replacing] }]),
    ).toEqual([
      "energy-system link heat-pump apply is 'replace' — a whole-cap link only adds (D944, D1076)",
    ])
  })
})
