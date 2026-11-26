import {
  DeviceType,
  linkedTriggerParamsOf,
  linkedTriggerValues,
  readRecipeLiteral,
} from '@camstack/types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ConfirmDialogProvider, DeviceFleetProvider } from '@camstack/ui-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { CustomizeDraftProvider } from '../../customize-draft'

const LIGHT = {
  id: 5767,
  name: 'Luce studio',
  addonId: 'ha',
  stableId: 'light.studio',
  type: DeviceType.Light,
  location: 'Studio',
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}
const LIVE = {
  blockId: '4864c0cc',
  updatedAt: 111,
  name: 'Pulsante studio → Luce studio',
  enabled: true,
  templateId: 'builtin:linked-trigger',
  values: linkedTriggerValues({
    targetDeviceId: 5767,
    action: 'toggle',
    sources: [
      {
        kind: 'device-fired',
        deviceId: 12,
        sourceIds: ['1'],
        eventIds: ['PRESS_SHORT'],
      },
      {
        kind: 'device-fired',
        deviceId: 12,
        sourceIds: ['2'],
        eventIds: ['PRESS_SHORT'],
      },
    ],
  }),
}

/** The thermometer's motion holds the light on for five minutes. */
const MOTION_HOLD = {
  blockId: 'hall',
  updatedAt: 222,
  name: 'Termometro → Luce studio',
  enabled: true,
  templateId: 'builtin:linked-trigger',
  values: linkedTriggerValues({
    targetDeviceId: 5767,
    action: 'on',
    onForSeconds: 300,
    sources: [
      {
        kind: 'device-becomes',
        deviceId: 14,
        cap: 'motion',
        fieldPath: 'detected',
        becomes: true,
      },
    ],
  }),
}

interface InstancesAnswer {
  readonly status: string
  readonly data?: { readonly instances: readonly unknown[] }
  readonly error?: { readonly message: string }
}
const instances = vi.hoisted((): { current: InstancesAnswer } => ({
  current: { status: 'success', data: { instances: [] } },
}))
const capsOf = vi.hoisted((): { current: ReadonlyMap<number, readonly string[]> } => ({
  current: new Map(),
}))
const offeredToPicker = vi.hoisted((): { current: unknown } => ({
  current: null,
}))
/** What the event-emitter slice answers: pending until a spec gives the device a vocabulary. */
const slice = vi.hoisted((): { current: { status: string; data: unknown } } => ({
  current: { status: 'pending', data: undefined },
}))
/** The camera joins the offered devices only in the specs that pick one. */
const withCamera = vi.hoisted((): { current: boolean } => ({ current: false }))
const create = vi.fn(async (_input: { block: { name: string; code: string } }) => ({}))
const SAVED = { block: { updatedAt: 999 } }
const update = vi.fn(
  async (_input: { blockId: string; block: { code: string }; expectedUpdatedAt: number }) => SAVED,
)
const remove = vi.fn(async (_input: { blockId: string; expectedUpdatedAt: number }) => ({}))
const setEnabled = vi.fn(
  async (_input: { blockId: string; enabled: boolean; expectedUpdatedAt: number }) => SAVED,
)

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceStateGetCapSlice: () => slice.current,
    useCoreBlocksListTemplateInstances: () => ({
      ...instances.current,
      refetch: vi.fn(async () => undefined),
    }),
    useCoreBlocksCreate: () => ({ mutateAsync: create }),
    useCoreBlocksUpdate: () => ({ mutateAsync: update }),
    useCoreBlocksDelete: () => ({ mutateAsync: remove }),
    useCoreBlocksSetEnabled: () => ({ mutateAsync: setEnabled }),
  }
})
vi.mock('../../assignments/use-cap-index', () => ({
  useCapIndex: () => ({ kind: 'known', value: capsOf.current }),
}))
const CAMERA = vi.hoisted(() => ({
  id: 15,
  name: 'Telecamera',
  addonId: 'cam',
  stableId: 'c15',
  type: 'camera',
  location: 'Ingresso',
  isCamera: true,
  integration: 'Reolink',
}))
vi.mock('../../assignments/use-source-candidates', () => ({
  useCandidateDevices: () => ({
    kind: 'known',
    value: [
      ...(withCamera.current ? [CAMERA] : []),
      {
        id: 12,
        name: 'Pulsante studio',
        addonId: 'hm',
        stableId: 'b12',
        parentDeviceId: 99,
        type: 'button',
        location: 'Studio',
        isCamera: false,
        integration: 'Homematic',
      },
      {
        id: 13,
        name: 'Pulsante ingresso',
        addonId: 'hm',
        stableId: 'b13',
        type: 'button',
        location: 'Ingresso',
        isCamera: false,
        integration: 'Homematic',
      },
      {
        id: 14,
        name: 'Termometro',
        addonId: 'hm',
        stableId: 't14',
        type: 'sensor',
        location: 'Studio',
        isCamera: false,
        integration: 'Homematic',
      },
    ],
  }),
}))
/** The limit controls need a tRPC client of their own (a device picker); the trigger spec does not. */
vi.mock('../../../../../pages/build/templates/TemplateInputsForm', () => ({
  TimeWindowControl: (p: { onChange: (value: unknown) => void }) => (
    <button type="button" onClick={() => p.onChange({ preset: 'night' })}>
      set-window
    </button>
  ),
  DeviceStateControl: (p: { onChange: (value: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        p.onChange({ deviceId: 5767, cap: 'switch', fieldPath: 'on', operator: 'eq', value: true })
      }
    >
      set-state
    </button>
  ),
}))
/** The common SourceSelector, stubbed to one button per offered device. */
vi.mock('../../source-selector/SourceSelector', () => ({
  SourceSelector: (p: {
    kind: string
    selection: string
    candidates: { kind: string; value?: readonly { deviceId: number }[] }
    picked: readonly number[]
    onPickedChange: (ids: readonly number[]) => void
  }) => {
    offeredToPicker.current = {
      ...p.candidates,
      kind: p.kind,
      selection: p.selection,
    }
    return (
      <div data-testid="source-selector-stub" data-picked={p.picked.join(',')}>
        {(p.candidates.value ?? []).map((c) => (
          <button key={c.deviceId} type="button" onClick={() => p.onPickedChange([c.deviceId])}>
            {`pick-${String(c.deviceId)}`}
          </button>
        ))}
      </div>
    )
  },
}))
const { TriggeredByTable } = await import('../TriggeredByTable')

function wrap(node: ReactNode): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ConfirmDialogProvider>
        <CustomizeDraftProvider order={['triggers']}>{node}</CustomizeDraftProvider>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  )
}

/** The section's own Save: nothing is written until it is pressed. */
function pressSave(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))
}

/** The trigger dialog's Save: it only moves the change into the section's draft. */
function saveDialog(): void {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Save$/i }))
}

function paramsIn(code: string) {
  const read = readRecipeLiteral(code)
  const link = read.status === 'recipe' ? read.recipe.template : undefined
  return link === undefined ? null : linkedTriggerParamsOf(link.values)
}

beforeEach(() => {
  instances.current = { status: 'success', data: { instances: [LIVE] } }
  // Every device carries `switch` and `event-emitter` here except the thermometer.
  capsOf.current = new Map([
    [5767, ['switch']],
    [12, ['event-emitter']],
    [13, ['event-emitter']],
  ])
  offeredToPicker.current = null
  slice.current = { status: 'pending', data: undefined }
  withCamera.current = false
  for (const fn of [create, update, remove, setEnabled]) fn.mockClear()
})

describe('TriggeredByTable', () => {
  it('shows the stored trigger as one row: source, event and parts, action', () => {
    render(wrap(<TriggeredByTable device={LIGHT} />))
    expect(screen.getByText('Pulsante studio')).toBeTruthy()
    expect(screen.getByText(/PRESS_SHORT/)).toBeTruthy()
    expect(screen.getByText(/1, 2/)).toBeTruthy()
  })

  it('is absent on a device nothing can command and that has no trigger', () => {
    instances.current = { status: 'success', data: { instances: [] } }
    capsOf.current = new Map()
    const { container } = render(wrap(<TriggeredByTable device={LIGHT} />))
    expect(container.textContent).toBe('')
  })

  it('does not claim "none" while the triggers have not answered', () => {
    instances.current = { status: 'pending' }
    render(wrap(<TriggeredByTable device={LIGHT} />))
    expect(screen.queryByText(/None/i)).toBeNull()
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('offers only event-emitting devices that are not already a source, and creates one automation per pick', async () => {
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(screen.getByRole('button', { name: /Add trigger/i }))
    const offered = offeredToPicker.current as {
      value: readonly { deviceId: number }[]
    }
    expect(offered.value.map((c) => c.deviceId)).toEqual([13])
    fireEvent.click(screen.getByText('pick-13'))
    saveDialog()
    expect(screen.getByText('Pulsante ingresso')).toBeTruthy()
    expect(create).not.toHaveBeenCalled()
    pressSave()
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const block = create.mock.calls[0]?.[0].block
    expect(paramsIn(block?.code ?? '')).toEqual({
      targetDeviceId: 5767,
      action: 'toggle',
      capability: 'switch',
      sources: [{ kind: 'device-fired', deviceId: 13 }],
    })
  })

  it('removing the only source deletes the automation only when saved', async () => {
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(screen.getByRole('button', { name: /Remove Pulsante studio/i }))
    // The remove asks first, naming the source; nothing is dropped until it is confirmed.
    const ask = await screen.findByRole('dialog')
    expect(ask.textContent).toContain('Pulsante studio')
    fireEvent.click(within(ask).getByRole('button', { name: /remove/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remove).not.toHaveBeenCalled()
    await screen.findByRole('button', { name: /^Save$/i })
    pressSave()
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith({ blockId: '4864c0cc', expectedUpdatedAt: 111 }),
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('changing the action writes only the code, so the fields it does not own stay on the block', async () => {
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(
      screen.getByRole('combobox', {
        name: /Action when Pulsante studio fires/i,
      }),
    )
    fireEvent.click(await screen.findByRole('option', { name: /off/i }))
    expect(update).not.toHaveBeenCalled()
    pressSave()
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const sent: unknown = update.mock.calls[0]?.[0]
    expect(sent).toMatchObject({ blockId: '4864c0cc' })
    const block: unknown = Reflect.get(Object(sent), 'block')
    expect(Object.keys(Object(block))).toEqual(['code'])
    expect(String(Reflect.get(Object(block), 'code'))).toContain('switch.off')
  })

  it('choosing "On for" holds the device on for five minutes, written with the same partial update', async () => {
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(
      screen.getByRole('combobox', {
        name: /Action when Pulsante studio fires/i,
      }),
    )
    fireEvent.click(await screen.findByRole('option', { name: 'On for' }))
    pressSave()
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const block = update.mock.calls[0]?.[0].block
    expect(Object.keys(Object(block))).toEqual(['code'])
    expect(paramsIn(block?.code ?? '')).toMatchObject({
      action: 'on',
      onForSeconds: 300,
    })
  })

  it('a motion trigger shows its time one field per unit, and writes it only when saved', async () => {
    instances.current = {
      status: 'success',
      data: { instances: [MOTION_HOLD] },
    }
    render(wrap(<TriggeredByTable device={LIGHT} />))
    expect(screen.getByText('Motion detected')).toBeTruthy()
    const minutes = screen.getByTestId('trigger-on-for-hall:14-minutes')
    expect(minutes).toHaveProperty('value', '5')
    fireEvent.change(minutes, { target: { value: '10' } })
    fireEvent.blur(minutes)
    expect(update).not.toHaveBeenCalled()
    pressSave()
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(paramsIn(update.mock.calls[0]?.[0].block.code ?? '')).toMatchObject({
      action: 'on',
      onForSeconds: 600,
    })
  })

  it('a time outside one second to one day is not written', async () => {
    instances.current = {
      status: 'success',
      data: { instances: [MOTION_HOLD] },
    }
    render(wrap(<TriggeredByTable device={LIGHT} />))
    const minutes = screen.getByTestId('trigger-on-for-hall:14-minutes')
    fireEvent.change(minutes, { target: { value: '0' } })
    fireEvent.blur(minutes)
    await Promise.resolve()
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it("a time above the device's run limit is never drafted, so Save cannot write it", async () => {
    instances.current = {
      status: 'success',
      data: { instances: [MOTION_HOLD] },
    }
    // A siren may be held on for ten minutes at most.
    render(wrap(<TriggeredByTable device={{ ...LIGHT, role: 'siren' }} />))
    const minutes = screen.getByTestId('trigger-on-for-hall:14-minutes')
    fireEvent.change(minutes, { target: { value: '30' } })
    fireEvent.blur(minutes)
    await Promise.resolve()
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('a picked motion sensor becomes "on for five minutes" on its motion', async () => {
    capsOf.current = new Map([
      [5767, ['switch']],
      [13, ['motion']],
    ])
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(screen.getByRole('button', { name: /Add trigger/i }))
    fireEvent.click(screen.getByText('pick-13'))
    saveDialog()
    pressSave()
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(paramsIn(create.mock.calls[0]?.[0].block.code ?? '')).toEqual({
      targetDeviceId: 5767,
      action: 'on',
      capability: 'switch',
      onForSeconds: 300,
      sources: [
        {
          kind: 'device-becomes',
          deviceId: 13,
          cap: 'motion',
          fieldPath: 'detected',
          becomes: true,
        },
      ],
    })
  })

  it('Discard drops every pending edit without a write, and the stored row is back', async () => {
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(screen.getByRole('button', { name: /Remove Pulsante studio/i }))
    const ask = await screen.findByRole('dialog')
    fireEvent.click(within(ask).getByRole('button', { name: /remove/i }))
    await waitFor(() => expect(screen.queryByText('Pulsante studio')).toBeNull())
    expect(screen.queryByText('Pulsante studio')).toBeNull()
    // The bar follows the section's pending count a render later than the row leaves.
    fireEvent.click(await screen.findByRole('button', { name: /^Discard$/i }))
    expect(screen.getByText('Pulsante studio')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull()
    for (const fn of [create, update, remove, setEnabled]) expect(fn).not.toHaveBeenCalled()
  })

  it('the active switch is a pending change too, written as one setEnabled on Save', async () => {
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(screen.getByRole('switch', { name: /Active/i }))
    expect(setEnabled).not.toHaveBeenCalled()
    pressSave()
    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith({
        blockId: '4864c0cc',
        enabled: false,
        expectedUpdatedAt: 111,
      }),
    )
  })

  it('names a trigger it cannot read and never rewrites it', () => {
    instances.current = {
      status: 'success',
      data: {
        instances: [{ ...LIVE, blockId: 'zz', name: 'Strano', values: { target: 5767 } }],
      },
    }
    render(wrap(<TriggeredByTable device={LIGHT} />))
    expect(screen.getByRole('alert').textContent).toContain('Strano')
  })

  it('names a source like every other device list: the parent first, then the device', () => {
    const fleet = [
      {
        id: 99,
        name: 'Telecomando',
        type: 'container',
        stableId: 'c99',
        parentDeviceId: null,
      },
      {
        id: 12,
        name: 'Pulsante studio',
        type: 'button',
        stableId: 'b12',
        parentDeviceId: 99,
      },
    ]
    render(
      wrap(
        <DeviceFleetProvider devices={fleet}>
          <TriggeredByTable device={LIGHT} />
        </DeviceFleetProvider>,
      ),
    )
    expect(screen.queryByText('Pulsante studio')).toBeNull()
    expect(screen.getAllByText(/Telecomando/).length).toBeGreaterThan(0)
  })

  it('an edit that changes only the source device keeps every condition and writes only the code', async () => {
    const perPart = {
      ...LIVE,
      values: linkedTriggerValues({
        targetDeviceId: 5767,
        action: 'toggle',
        sources: [
          {
            kind: 'device-fired',
            deviceId: 12,
            sourceIds: ['1'],
            eventIds: ['PRESS_SHORT'],
          },
          {
            kind: 'device-fired',
            deviceId: 12,
            sourceIds: ['2'],
            eventIds: ['PRESS_LONG'],
          },
        ],
      }),
    }
    instances.current = { status: 'success', data: { instances: [perPart] } }
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(
      screen.getByRole('button', {
        name: /Edit the trigger from .*Pulsante studio/i,
      }),
    )
    fireEvent.click(screen.getByText('pick-13'))
    saveDialog()
    expect(update).not.toHaveBeenCalled()
    pressSave()
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const block = update.mock.calls[0]?.[0].block
    expect(update.mock.calls[0]?.[0].blockId).toBe('4864c0cc')
    expect(Object.keys(Object(block))).toEqual(['code'])
    expect(paramsIn(block?.code ?? '')?.sources).toEqual([
      {
        kind: 'device-fired',
        deviceId: 13,
        sourceIds: ['1'],
        eventIds: ['PRESS_SHORT'],
      },
      {
        kind: 'device-fired',
        deviceId: 13,
        sourceIds: ['2'],
        eventIds: ['PRESS_LONG'],
      },
    ])
  })

  it('an edit saved without touching anything is not a change', () => {
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(
      screen.getByRole('button', {
        name: /Edit the trigger from .*Pulsante studio/i,
      }),
    )
    saveDialog()
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('Add and Edit open the same single dialog, with the common SourceSelector inside', () => {
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(screen.getByRole('button', { name: /Add trigger/i }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByTestId('source-selector-stub')).toBeTruthy()
    expect(offeredToPicker.current).toMatchObject({
      kind: 'devices',
      selection: 'single',
    })
    expect(screen.getByTestId('source-selector-stub').getAttribute('data-picked')).toBe('')
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: /^Cancel$/i,
      }),
    )
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(
      screen.getByRole('button', {
        name: /Edit the trigger from .*Pulsante studio/i,
      }),
    )
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByTestId('source-selector-stub')).toBeTruthy()
    expect(offeredToPicker.current).toMatchObject({
      kind: 'devices',
      selection: 'single',
    })
    // The source being edited is offered and chosen, beside the devices that are not yet a source.
    expect(screen.getByTestId('source-selector-stub').getAttribute('data-picked')).toBe('12')
    const offered = offeredToPicker.current as {
      value: readonly { deviceId: number }[]
    }
    expect(offered.value.map((c) => c.deviceId)).toEqual([12, 13])
  })

  it('a device-event trigger opens the edit dialog too', () => {
    instances.current = {
      status: 'success',
      data: {
        instances: [
          {
            ...LIVE,
            values: linkedTriggerValues({
              targetDeviceId: 5767,
              action: 'toggle',
              sources: [{ kind: 'device-event', deviceId: 12, category: 'doorbell' }],
            }),
          },
        ],
      },
    }
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(
      screen.getByRole('button', {
        name: /Edit the trigger from .*Pulsante studio/i,
      }),
    )
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  describe('the one dialog writes what it shows', () => {
    const FLEET = [
      { id: 5767, name: 'Luce studio', type: 'light', stableId: 'l', parentDeviceId: null },
      { id: 12, name: 'Pulsante studio', type: 'button', stableId: 'b12', parentDeviceId: null },
      { id: 13, name: 'Pulsante ingresso', type: 'button', stableId: 'b13', parentDeviceId: null },
      { id: 15, name: 'Telecamera', type: 'camera', stableId: 'c15', parentDeviceId: null },
    ]
    const renderTable = (): void => {
      render(
        wrap(
          <DeviceFleetProvider devices={FLEET}>
            <TriggeredByTable device={LIGHT} />
          </DeviceFleetProvider>,
        ),
      )
    }
    const openEdit = (): void => {
      fireEvent.click(
        screen.getByRole('button', { name: /Edit the trigger from .*Pulsante studio/i }),
      )
    }
    const openAdd = (): void => {
      fireEvent.click(screen.getByRole('button', { name: /Add trigger/i }))
    }
    const writtenParams = async () => {
      pressSave()
      await waitFor(() => expect(create.mock.calls.length + update.mock.calls.length).toBe(1))
      const code = create.mock.calls[0]?.[0].block.code ?? update.mock.calls[0]?.[0].block.code
      return paramsIn(code ?? '')
    }

    it('a new emitter trigger writes the events and parts chosen in the dialog', async () => {
      slice.current = {
        status: 'success',
        data: {
          eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
          vocabulary: [
            { id: 'PRESS_SHORT', label: 'Short press', source: { id: '1', label: 'Top' } },
            { id: 'PRESS_LONG', label: 'Long press', source: { id: '1', label: 'Top' } },
            { id: 'PRESS_SHORT', label: 'Short press', source: { id: '2', label: 'Bottom' } },
            { id: 'PRESS_LONG', label: 'Long press', source: { id: '2', label: 'Bottom' } },
          ],
          lastEvent: null,
          eventCountSinceStart: 0,
        },
      }
      instances.current = { status: 'success', data: { instances: [] } }
      renderTable()
      openAdd()
      fireEvent.click(screen.getByText('pick-13'))
      const events = screen.getByRole('group', { name: 'Events' })
      fireEvent.click(within(events).getByRole('button', { name: 'Long press' }))
      const parts = screen.getByRole('group', { name: 'Parts of the device' })
      fireEvent.click(within(parts).getByRole('button', { name: 'Bottom' }))
      saveDialog()
      const params = await writtenParams()
      expect(params?.sources).toEqual([
        {
          kind: 'device-fired',
          deviceId: 13,
          sourceIds: ['1'],
          eventIds: ['PRESS_SHORT'],
        },
      ])
    })

    it('a new camera trigger writes the classes chosen in the dialog', async () => {
      instances.current = { status: 'success', data: { instances: [] } }
      withCamera.current = true
      renderTable()
      openAdd()
      fireEvent.click(screen.getByText('pick-15'))
      const classes = screen.getByRole('group', { name: 'Detected classes' })
      fireEvent.click(within(classes).getByRole('button', { name: 'Vehicle' }))
      saveDialog()
      const params = await writtenParams()
      expect(params?.sources).toMatchObject([
        {
          kind: 'detection',
          deviceIds: [15],
          subjects: [{ macro: 'person' }, { macro: 'vehicle' }],
        },
      ])
    })

    it('the time window and the device-state limit are written with the trigger', async () => {
      instances.current = { status: 'success', data: { instances: [] } }
      renderTable()
      openAdd()
      fireEvent.click(screen.getByText('pick-13'))
      fireEvent.click(screen.getByRole('button', { name: 'set-window' }))
      fireEvent.click(screen.getByRole('button', { name: 'set-state' }))
      saveDialog()
      const params = await writtenParams()
      expect(params?.activeWindow).toEqual({ preset: 'night' })
      expect(params?.activeWhen).toMatchObject({ cap: 'switch', fieldPath: 'on', value: true })
    })

    it('an edit keeps the stored conditions of the source it does not change and adds a limit', async () => {
      renderTable()
      openEdit()
      fireEvent.click(screen.getByRole('button', { name: 'set-window' }))
      saveDialog()
      const params = await writtenParams()
      expect(params?.activeWindow).toEqual({ preset: 'night' })
      expect(params?.sources).toEqual(
        paramsIn(String(update.mock.calls[0]?.[0].block.code))?.sources,
      )
      expect(
        (params?.sources ?? []).map((source) =>
          source.kind === 'device-fired' ? source.eventIds : null,
        ),
      ).toEqual([['PRESS_SHORT'], ['PRESS_SHORT']])
    })

    it('moving the source to another kind drops the old conditions', async () => {
      withCamera.current = true
      renderTable()
      openEdit()
      fireEvent.click(screen.getByText('pick-15'))
      saveDialog()
      const params = await writtenParams()
      expect(params?.sources).toMatchObject([
        { kind: 'detection', deviceIds: [15], subjects: [{ macro: 'person' }] },
      ])
      expect(JSON.stringify(params?.sources)).not.toContain('PRESS_SHORT')
    })

    it('a source whose kind is not answered keeps its conditions, the limits and Save', async () => {
      capsOf.current = new Map([[5767, ['switch']]])
      renderTable()
      openEdit()
      expect(screen.getByTestId('trigger-conditions')).toBeTruthy()
      const save = within(screen.getByRole('dialog')).getByRole('button', { name: /^Save$/i })
      expect((save as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'set-state' }))
      saveDialog()
      const params = await writtenParams()
      expect(params?.activeWhen).toMatchObject({ cap: 'switch' })
    })
  })
})
