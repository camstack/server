/**
 * An event row has the actions every row has: edit, the library Switch for
 * active / inactive, and a remove that asks first. Both writes plan against the
 * stored composition (D391): the switch keeps the stored feature and flips only
 * `enabled`; the remove drops the feature.
 */
import { CAP_CUSTOMIZE_CATALOG, type Composition, DeviceInfoSchema } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { resolveCustomization } from '../../customization-read'
import type { CustomizeRowSpec } from '../customize-rows'

const confirmed = vi.hoisted(() => ({ asked: [] as string[], answer: true }))
vi.mock('../../use-confirm-remove', () => ({
  useConfirmRemove: () => async (what: string) => {
    confirmed.asked.push(what)
    return confirmed.answer
  },
}))

const { EventActionsCell } = await import('../EventRowCells')

const TARGET = { addonId: 'provider-hikvision', stableId: 'cam-1' }
const STORED: Composition = {
  target: { kind: 'existing', device: TARGET },
  features: [
    {
      kind: 'fields',
      cap: 'doorbell',
      fields: { lastRingAt: { kind: 'expression', expr: '1', bindings: {} } },
    },
  ],
}
const RING = CAP_CUSTOMIZE_CATALOG['doorbell']?.targets.find((t) => t.cardinality === 'event')
const SPEC: CustomizeRowSpec | null =
  RING === undefined
    ? null
    : {
        key: `doorbell.${RING.id}`,
        cap: 'doorbell',
        kind: 'event',
        section: 'events',
        target: RING,
      }
const ROW_KEY = SPEC?.key ?? ''
const STATE = resolveCustomization({
  status: 'success',
  error: null,
  data: {
    state: 'loaded',
    view: {
      block: {
        id: 'blk',
        name: 'customize:provider-hikvision/cam-1',
        code: '',
        enabled: true,
        placement: 'hub',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'admin',
        status: 'running',
        lastChangedAt: 1,
        source: { kind: 'composition', composition: STORED },
      },
      state: { kind: 'answered', state: null },
    },
  },
})

/** A device built through the schema, so the fixture cannot drift from the type. */
const DEVICE = DeviceInfoSchema.parse({
  id: 1,
  name: 'Doorbell',
  addonId: TARGET.addonId,
  stableId: TARGET.stableId,
  type: 'camera',
  location: null,
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: true,
  config: {},
})

const save = vi.fn(async (_next: Composition | null) => ({ kind: 'saved' as const }))

function renderCell(): void {
  if (SPEC === null) throw new Error('doorbell event target missing from the catalog')
  render(
    <EventActionsCell
      spec={SPEC}
      title="Doorbell"
      device={DEVICE}
      handle={{ target: TARGET, state: STATE, saving: false, save }}
      sensors={{
        presence: 'pending',
        status: null,
        failureReason: null,
        refetch: async () => 'answered',
      }}
      onEdit={() => undefined}
      onError={() => undefined}
    />,
  )
}

beforeEach(() => {
  save.mockClear()
  confirmed.asked = []
  confirmed.answer = true
})

describe('EventActionsCell', () => {
  it('the Switch turns the stored event off and keeps the rest of the feature', async () => {
    renderCell()
    fireEvent.click(screen.getByTestId(`event-active-${ROW_KEY}`))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const saved = save.mock.calls[0]?.[0] ?? null
    expect(saved).not.toBeNull()
    expect(saved?.features).toEqual([{ ...STORED.features[0], enabled: false }])
  })

  it('Remove asks first, then drops the feature (and the empty customization with it)', async () => {
    renderCell()
    fireEvent.click(screen.getByTestId(`event-remove-${ROW_KEY}`))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(confirmed.asked).toHaveLength(1)
    expect(save).toHaveBeenCalledWith(null)
  })

  it('a declined confirm writes nothing', async () => {
    confirmed.answer = false
    renderCell()
    fireEvent.click(screen.getByTestId(`event-remove-${ROW_KEY}`))
    await waitFor(() => expect(confirmed.asked).toHaveLength(1))
    expect(save).not.toHaveBeenCalled()
  })
})
