import {
  type Composition,
  type CompositionView,
  compileHelper,
  type CoreBlock,
  type HelperSpec,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildCompositionRows,
  describeCompositionState,
  type FleetLookup,
  fleetLookupOf,
  originOfComposition,
} from '../composition-rows'

function block(over: Partial<CoreBlock>): CoreBlock {
  return {
    id: 'b',
    name: 'Block',
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'u',
    status: 'running',
    lastChangedAt: 1,
    ...over,
  }
}

const CAMERA = { addonId: 'provider-hikvision', stableId: 'cam' }
const BELL = { addonId: 'provider-homeassistant', stableId: 'bell' }

/** A customization of CAMERA reading BELL and — like the doorbell counter — itself. */
function customization(over: Partial<CoreBlock> = {}): CompositionView {
  return {
    block: block({
      id: 'c1',
      name: 'customize:provider-hikvision/cam',
      source: {
        kind: 'composition',
        composition: {
          target: { kind: 'existing', device: CAMERA },
          features: [
            {
              kind: 'fields',
              cap: 'doorbell',
              fields: {
                lastPressedAt: { kind: 'from', source: BELL, cap: 'switch', fieldPath: 'on' },
                pressCountSinceStart: {
                  kind: 'expression',
                  expr: 'count(x)',
                  bindings: {
                    x: {
                      kind: 'from',
                      source: CAMERA,
                      cap: 'doorbell',
                      fieldPath: 'lastPressedAt',
                    },
                  },
                },
              },
            },
          ],
        },
      },
      ...over,
    }),
    state: {
      kind: 'answered',
      state: { blockId: 'c1', deviceId: 101, status: 'running', fields: [] },
    },
  }
}

const ANSWERED: FleetLookup = fleetLookupOf([
  { id: 101, ...CAMERA, name: 'Front camera', type: 'camera' },
  { id: 1031, ...BELL, name: 'Bell', type: 'switch' },
])
const UNANSWERED: FleetLookup = { state: 'unanswered', reason: 'pending' }

describe('buildCompositionRows', () => {
  it('lists a customization under its device, with its sources and never itself as a source', () => {
    const { composed, customizations } = buildCompositionRows([customization()], ANSWERED)
    expect(composed).toEqual([])
    expect(customizations).toHaveLength(1)
    const row = customizations[0]
    expect(row?.name).toBe('Front camera')
    expect(row?.type).toBe('camera')
    expect(row?.sources.map((s) => [s.label, s.presence, s.deviceId])).toEqual([
      ['Bell', 'present', 1031],
    ])
  })

  it('a source the answered device list does not hold is missing, by reference', () => {
    const fleet = fleetLookupOf([{ id: 101, ...CAMERA, name: 'Front camera', type: 'camera' }])
    const row = buildCompositionRows([customization()], fleet).customizations[0]
    expect(row?.sources).toEqual([
      {
        key: 'provider-homeassistant/bell',
        label: 'provider-homeassistant/bell',
        presence: 'missing',
        deviceId: null,
      },
    ])
  })

  it('an unanswered device list makes nothing missing (D315)', () => {
    const row = buildCompositionRows([customization()], UNANSWERED).customizations[0]
    expect(row?.namePresence).toBe('unknown')
    expect(row?.type).toBeNull()
    expect(row?.sources.map((s) => s.presence)).toEqual(['unknown'])
    // The composer still knows the device id, so the link survives.
    expect(row?.reportedDeviceId).toBe(101)
  })

  it('a disabled feature is shown as off', () => {
    const view = customization()
    const composition =
      view.block.source?.kind === 'composition' ? view.block.source.composition : null
    if (composition === null) throw new Error('fixture')
    const off: CompositionView = {
      ...view,
      block: {
        ...view.block,
        source: {
          kind: 'composition',
          composition: {
            ...composition,
            features: composition.features.map((f) => ({ ...f, enabled: false })),
          },
        },
      },
    }
    expect(buildCompositionRows([off], ANSWERED).customizations[0]?.features).toEqual([
      'doorbell (off)',
    ])
  })

  it('a target the answered device list does not hold is missing, by reference', () => {
    const fleet = fleetLookupOf([{ id: 1031, ...BELL, name: 'Bell', type: 'switch' }])
    const row = buildCompositionRows([customization()], fleet).customizations[0]
    expect(row?.namePresence).toBe('missing')
  })
})

describe('describeCompositionState', () => {
  it('failed carries the composer reason', () => {
    const view = customization()
    const failed: CompositionView = {
      ...view,
      state: {
        kind: 'answered',
        state: {
          blockId: 'c1',
          deviceId: 101,
          status: 'failed',
          reason: 'source gone',
          fields: [],
        },
      },
    }
    expect(describeCompositionState(failed)).toEqual({
      tone: 'error',
      label: 'Failed',
      reason: 'source gone',
    })
  })

  it('failed with no reason anywhere still says something', () => {
    const view = customization()
    const failed: CompositionView = {
      ...view,
      state: {
        kind: 'answered',
        state: { blockId: 'c1', deviceId: 101, status: 'failed', fields: [] },
      },
    }
    expect(describeCompositionState(failed).reason).toMatch(/no reason recorded/)
  })

  it('a disabled block is off, whatever it last reported', () => {
    expect(describeCompositionState(customization({ enabled: false, status: 'failed' }))).toEqual({
      tone: 'idle',
      label: 'Off',
      reason: null,
    })
  })

  it('an unreachable composer is Unknown with its error, not the stored status', () => {
    const view: CompositionView = {
      ...customization({ status: 'running' }),
      state: { kind: 'unreachable', error: 'composer runner down' },
    }
    const state = describeCompositionState(view)
    expect(state.label).toBe('Unknown')
    expect(state.reason).toContain('composer runner down')
  })

  it('an answered composer with NO record of the block is never a green Running', () => {
    const view: CompositionView = {
      ...customization({ status: 'running' }),
      state: { kind: 'answered', state: null },
    }
    const state = describeCompositionState(view)
    expect(state.tone).toBe('pending')
    expect(state.label).toBe('Not reported yet')
    expect(state.reason).toContain('no record of this block')
    expect(state.reason).toContain('stored status: running')
  })

  it('a running block whose field is unavailable says how many, and why', () => {
    const view: CompositionView = {
      ...customization(),
      state: {
        kind: 'answered',
        state: {
          blockId: 'c1',
          deviceId: 101,
          status: 'running',
          fields: [
            { cap: 'doorbell', path: 'lastPressedAt', state: 'fresh', value: null },
            {
              cap: 'doorbell',
              path: 'pressCountSinceStart',
              state: 'unavailable',
              value: null,
              reason: 'the source has not reported `doorbell` yet',
            },
          ],
        },
      },
    }
    expect(describeCompositionState(view)).toEqual({
      tone: 'pending',
      label: 'Running',
      reason:
        '1 field unavailable — doorbell.pressCountSinceStart: the source has not reported `doorbell` yet',
    })
  })

  it('a running block whose fields are all fresh is plainly Running', () => {
    expect(describeCompositionState(customization())).toEqual({
      tone: 'ok',
      label: 'Running',
      reason: null,
    })
  })
})

describe('originOfComposition', () => {
  const member = {
    source: { addonId: 'provider-homeassistant', stableId: 'sensor.a' },
    cap: 'temperature-sensor',
    fieldPath: 'temperature',
  }
  function compositionOf(spec: HelperSpec): Composition {
    const compiled = compileHelper(spec)
    if (!compiled.ok) throw new Error('fixture did not compile')
    return compiled.composition
  }

  it('reads a group from the recorded helper spec', () => {
    const composition = compositionOf({
      kind: 'group',
      templateId: 'temperature',
      aggregate: 'sum',
      members: [member],
    })
    expect(originOfComposition(composition)).toEqual({ section: 'group', kind: 'temperature' })
  })

  it('keeps a legacy math sum a calculation, so it still lists', () => {
    const other = { ...member, source: { ...member.source, stableId: 'sensor.b' } }
    const composition = compositionOf({ kind: 'arithmetic', op: 'sum', inputs: [member, other] })
    expect(originOfComposition(composition)).toEqual({ section: 'calculation', kind: 'sum' })
  })

  it('files a composition without a helper spec under Advanced', () => {
    const view = customization()
    const composition =
      view.block.source?.kind === 'composition' ? view.block.source.composition : null
    if (composition === null) throw new Error('fixture')
    expect(originOfComposition(composition)).toEqual({ section: 'advanced', kind: null })
  })
})
