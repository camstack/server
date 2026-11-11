import { type Composition, DeviceType, runningOptOutFeature } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import type { CustomizationHandle } from '../../use-customization'
import { FollowSwitchToggle } from '../FollowSwitchToggle'

const PLUG = { addonId: 'provider-mqtt-ha', stableId: 'plug-1' }
const held: { composition: Composition | null } = { composition: null }
const confirmMock = vi.fn(async () => true)

vi.mock('../../customization-read', () => ({
  currentComposition: () => held.composition,
}))
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return { ...actual, useConfirm: () => confirmMock }
})

function heater(extra: Composition['features'] = []): Composition {
  return {
    target: { kind: 'new', type: DeviceType.Fan },
    features: [
      {
        kind: 'fields',
        cap: 'switch',
        fields: {
          on: { kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' },
          lastChangedAt: {
            kind: 'from',
            source: PLUG,
            cap: 'switch',
            fieldPath: 'lastChangedAt',
          },
        },
        commands: {
          setState: {
            kind: 'forward',
            source: PLUG,
            cap: 'switch',
            method: 'setState',
          },
        },
      },
      ...extra,
    ],
  }
}

const save = vi.fn()
const handle = (): CustomizationHandle => ({
  target: PLUG,
  state: { kind: 'none' },
  saving: false,
  save,
})

describe('FollowSwitchToggle', () => {
  beforeEach(() => {
    save.mockReset()
    save.mockResolvedValue({ kind: 'saved' })
    confirmMock.mockClear()
  })

  it('renders nothing when the device has no actuator switch', () => {
    held.composition = null
    const { container } = render(<FollowSwitchToggle handle={handle()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is on by default and saves the opt-out when turned off', async () => {
    held.composition = heater()
    render(<FollowSwitchToggle handle={handle()} />)
    const toggle = screen.getByTestId('follow-switch-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]?.[0]?.features.map((f: { cap: string }) => f.cap)).toEqual([
      'switch',
      'running-state',
    ])
  })

  it('turning it on over the opt-out removes it without asking', async () => {
    held.composition = heater([runningOptOutFeature()])
    render(<FollowSwitchToggle handle={handle()} />)
    fireEvent.click(screen.getByTestId('follow-switch-toggle'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(confirmMock).not.toHaveBeenCalled()
    expect(save.mock.calls[0]?.[0]?.features).toHaveLength(1)
  })

  it('asks before it discards a written rule, and keeps it on a refusal', async () => {
    held.composition = heater([
      {
        kind: 'fields',
        cap: 'running-state',
        fields: {
          running: {
            kind: 'from',
            source: PLUG,
            cap: 'switch',
            fieldPath: 'on',
          },
        },
      },
    ])
    confirmMock.mockResolvedValueOnce(false)
    render(<FollowSwitchToggle handle={handle()} />)
    fireEvent.click(screen.getByTestId('follow-switch-toggle'))
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1))
    expect(save).not.toHaveBeenCalled()
  })

  it('shows the refusal of a save', async () => {
    held.composition = heater()
    save.mockResolvedValue({ kind: 'refused', reason: 'nope' })
    render(<FollowSwitchToggle handle={handle()} />)
    fireEvent.click(screen.getByTestId('follow-switch-toggle'))
    expect(await screen.findByRole('alert')).toHaveTextContent('nope')
  })
})
