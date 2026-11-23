import {
  DeviceType,
  linkedTriggerParamsOf,
  linkedTriggerValues,
  readRecipeLiteral,
} from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DeviceFleetProvider } from '@camstack/ui-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'

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
const confirmAnswer = vi.hoisted((): { current: boolean } => ({
  current: true,
}))
const create = vi.fn(async (_input: { block: { name: string; code: string } }) => ({}))
const update = vi.fn(async (_input: { blockId: string; block: { code: string } }) => ({}))
const remove = vi.fn(async (_input: { blockId: string }) => ({}))
const setEnabled = vi.fn(async (_input: { blockId: string; enabled: boolean }) => ({}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useConfirm: () => async () => confirmAnswer.current,
    useDeviceStateGetCapSlice: () => ({ status: 'pending', data: undefined }),
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
vi.mock('../../assignments/use-source-candidates', () => ({
  useCandidateDevices: () => ({
    kind: 'known',
    value: [
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
vi.mock('../../source-selector/SourceSelectorDevicesDialog', () => ({
  SourceSelectorDevicesDialog: (p: {
    open: boolean
    candidates: { kind: string; value?: readonly { deviceId: number }[] }
    onConfirm: (c: readonly unknown[]) => void
  }) => {
    offeredToPicker.current = p.candidates
    return p.open ? (
      <button
        type="button"
        onClick={() => p.onConfirm((p.candidates.value ?? []).filter((c) => c.deviceId === 13))}
      >
        pick-13
      </button>
    ) : null
  },
}))
const { TriggeredByTable } = await import('../TriggeredByTable')

function wrap(node: ReactNode): ReactNode {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
}

function paramsIn(code: string) {
  const read = readRecipeLiteral(code)
  const link = read.status === 'recipe' ? read.recipe.template : undefined
  return link === undefined ? null : linkedTriggerParamsOf(link.values)
}

beforeEach(() => {
  confirmAnswer.current = true
  instances.current = { status: 'success', data: { instances: [LIVE] } }
  // Every device carries `switch` and `event-emitter` here except the thermometer.
  capsOf.current = new Map([
    [5767, ['switch']],
    [12, ['event-emitter']],
    [13, ['event-emitter']],
  ])
  offeredToPicker.current = null
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
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const block = create.mock.calls[0]?.[0].block
    expect(paramsIn(block?.code ?? '')).toEqual({
      targetDeviceId: 5767,
      action: 'toggle',
      capability: 'switch',
      sources: [{ kind: 'device-fired', deviceId: 13 }],
    })
  })

  it('removing the only source deletes the automation after a confirmation', async () => {
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(screen.getByRole('button', { name: /Remove Pulsante studio/i }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ blockId: '4864c0cc' }))
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
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const block = update.mock.calls[0]?.[0].block
    expect(Object.keys(Object(block))).toEqual(['code'])
    expect(paramsIn(block?.code ?? '')).toMatchObject({
      action: 'on',
      onForSeconds: 300,
    })
  })

  it('a motion trigger shows its time one field per unit, and writes it once the fields are left', async () => {
    instances.current = {
      status: 'success',
      data: { instances: [MOTION_HOLD] },
    }
    render(wrap(<TriggeredByTable device={LIGHT} />))
    expect(screen.getByText('Motion detected')).toBeTruthy()
    const minutes = screen.getByTestId('trigger-on-for-hall:14-minutes')
    expect(minutes).toHaveProperty('value', '5')
    fireEvent.change(minutes, { target: { value: '10' } })
    expect(update).not.toHaveBeenCalled()
    fireEvent.blur(minutes)
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

  it('a refused confirmation removes nothing', async () => {
    confirmAnswer.current = false
    render(wrap(<TriggeredByTable device={LIGHT} />))
    fireEvent.click(screen.getByRole('button', { name: /Remove Pulsante studio/i }))
    await Promise.resolve()
    expect(remove).not.toHaveBeenCalled()
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

  it('a trigger narrowed per part is editable, and saving writes only the code with one pick', async () => {
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
        name: /Choose the events of .*Pulsante studio/i,
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Save$/i }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    const block = update.mock.calls[0]?.[0].block
    expect(Object.keys(Object(block))).toEqual(['code'])
    expect(paramsIn(block?.code ?? '')?.sources).toEqual([
      {
        kind: 'device-fired',
        deviceId: 12,
        sourceIds: ['1', '2'],
        eventIds: ['PRESS_SHORT', 'PRESS_LONG'],
      },
    ])
  })

  it('a device-event trigger is editable too', () => {
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
    expect(
      screen.getByRole('button', {
        name: /Choose the events of .*Pulsante studio/i,
      }),
    ).toBeTruthy()
  })
})
