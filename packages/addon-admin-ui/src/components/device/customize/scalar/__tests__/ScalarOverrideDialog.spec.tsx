import { DeviceType } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import type { CompositionFieldsFeature } from '@camstack/types'
import {
  DISHWASHER,
  SWITCH_REF,
} from '../../../../../../../types/src/composition/customize/__fixtures__/refs.js'
import { CUSTOMIZE_STORED_CASES } from '../../../../../../../types/src/composition/customize/__fixtures__/stored-cases.js'

const HOST = {
  id: 501,
  name: 'Kitchen dishwasher',
  addonId: DISHWASHER.addonId,
  stableId: DISHWASHER.stableId,
  type: DeviceType.Dishwasher,
  location: 'Kitchen',
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}
const METER = {
  id: 305,
  name: 'Porch power meter',
  addonId: SWITCH_REF.addonId,
  stableId: SWITCH_REF.stableId,
  type: 'sensor',
  location: 'Kitchen',
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}
const GARAGE = { ...METER, id: 304, name: 'Garage lamp', stableId: 'lamp', location: 'Garage' }

const proposalResult = vi.hoisted(() => ({
  current: { status: 'pending' } as { status: string; data?: unknown },
}))

vi.mock('../../assignments/use-cap-index', () => ({
  useCapIndex: () => ({
    kind: 'known' as const,
    value: new Map<number, readonly string[]>([
      [305, ['power-meter']],
      [304, ['light']],
    ]),
  }),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useCoreBlocksProposeRunningThreshold: () => proposalResult.current,
    useDeviceManagerListAll: () => ({ status: 'success', data: [HOST, METER, GARAGE] }),
    useDeviceManagerGetWireableFields: ({ deviceId }: { deviceId: number }) =>
      deviceId === 305
        ? {
            status: 'success' as const,
            data: {
              caps: [
                { cap: 'power-meter', fields: [{ path: 'power', kind: 'number' as const }] },
                { cap: 'numeric-sensor', fields: [{ path: 'voltage', kind: 'number' as const }] },
              ],
            },
          }
        : { status: 'success' as const, data: { caps: [] } },
    useDeviceStateGetSnapshot: ({ deviceId }: { deviceId: number }) =>
      deviceId === 305
        ? {
            status: 'success' as const,
            data: {
              'power-meter': { power: 8.4, unit: 'W' },
              'numeric-sensor': { voltage: 231, unit: 'V' },
            },
          }
        : { status: 'success' as const, data: {} },
    DevicePicker: (p: {
      devices: readonly { id: number; name: string; location?: string }[]
      onChange: (ids: number[]) => void
      selection?: string
      groupBy?: string
      value: readonly number[]
    }) => (
      <div>
        <span data-testid="picker-selection">{p.selection}</span>
        <span data-testid="picker-group">{p.groupBy}</span>
        <span data-testid="picker-value">{p.value.join(',')}</span>
        {p.devices.map((device) => (
          <button key={device.id} type="button" onClick={() => p.onChange([device.id])}>
            {device.name}
            {device.location !== undefined ? ` · ${device.location}` : ''}
          </button>
        ))}
      </div>
    ),
  }
})

const { ScalarOverrideDialog } = await import('../ScalarOverrideDialog')

function powerStored(): CompositionFieldsFeature {
  const found = CUSTOMIZE_STORED_CASES.find((entry) => entry.id === 'running-power')
  if (found === undefined || found.stored.family !== 'composition') throw new Error('power')
  return found.stored.feature
}

describe('ScalarOverrideDialog', () => {
  it('suggests the same room, refuses the wrong unit, and saves the frozen power feature', () => {
    const onSave = vi.fn()
    render(
      <ScalarOverrideDialog
        open
        mode="add"
        title="Running"
        cap="running-state"
        targetId="running"
        host={HOST}
        target={DISHWASHER}
        apply="add"
        seed={null}
        canSave
        onClose={() => undefined}
        onSave={onSave}
      />,
    )
    expect(screen.queryByText(/Suggested ·/)).toBeNull()
    expect(screen.getAllByRole('button', { name: /Porch power meter/ })).toHaveLength(1)
    expect(screen.getByTestId('source-incompatible-devices')).toBeTruthy()
    expect(screen.getByTestId('source-selector')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Porch power meter/ }))
    // A value the target cannot read is not listed at all, collapsed or not.
    expect(screen.queryByTestId('source-incompatible-values')).toBeNull()
    fireEvent.click(screen.getByTestId('source-value-power-meter.power'))
    const watts = screen.getByTestId('source-value-power-meter.power')
    expect(watts instanceof HTMLInputElement && watts.checked).toBe(true)
    const deviceRow = screen.getAllByRole('button', { name: /Porch power meter/ })[0]
    if (deviceRow === undefined) throw new Error('device row missing')
    fireEvent.click(deviceRow)
    const still = screen.getByTestId('source-value-power-meter.power')
    expect(still instanceof HTMLInputElement && still.checked).toBe(true)
    expect(screen.getByTestId('scalar-preview').textContent).toMatch(/8\.4 W/)
    expect(screen.getByTestId('scalar-preview').textContent).toMatch(/30/)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(powerStored())
  })

  function renderPicked(onSave = vi.fn()) {
    render(
      <ScalarOverrideDialog
        open
        mode="add"
        title="Running"
        cap="running-state"
        targetId="running"
        host={HOST}
        target={DISHWASHER}
        apply="add"
        seed={null}
        canSave
        onClose={() => undefined}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Porch power meter/ }))
    fireEvent.click(screen.getByTestId('source-value-power-meter.power'))
    return onSave
  }
  const threshold = {
    kind: 'threshold' as const,
    comparison: 'gte' as const,
    threshold: 7,
    startDwellMs: 90_000,
    stopDwellMs: 600_000,
  }

  it('shows a pending proposal as an ellipsis', () => {
    proposalResult.current = { status: 'pending' }
    renderPicked()
    expect(screen.getByTestId('running-proposal').textContent).toMatch(/…/)
  })

  it('shows a proposal; Apply fills the fields and saves nothing', () => {
    proposalResult.current = {
      status: 'success',
      data: {
        state: 'proposal',
        transform: threshold,
        confidence: 'high',
        notes: [],
        evidence: { spanMs: 14 * 86_400_000, runsFound: 9 },
      },
    }
    const onSave = renderPicked()
    expect(screen.getByTestId('running-proposal').textContent).toMatch(
      /From 9 runs over 14 days: 7 W, start 90 s, stop 10 min/,
    )
    fireEvent.click(screen.getByTestId('running-proposal-apply'))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId('scalar-preview').textContent).toMatch(/90/)
  })

  it('names the reason and the defaults when history is insufficient', () => {
    proposalResult.current = {
      status: 'success',
      data: {
        state: 'insufficient',
        reason: 'span-too-short',
        evidence: { spanMs: 3600_000, points: 10, runsFound: 0 },
        fallback: { ...threshold, threshold: 5, startDwellMs: 30_000, stopDwellMs: 300_000 },
      },
    }
    renderPicked()
    const text = screen.getByTestId('running-proposal').textContent ?? ''
    expect(text).toMatch(/Less than a day/)
    expect(text).toMatch(/Defaults shown: 5 W, start 30 s, stop 5 min/)
    expect(screen.queryByTestId('running-proposal-apply')).toBeNull()
  })

  it('shows a short error line without blocking the dialog', () => {
    proposalResult.current = { status: 'error' }
    renderPicked()
    expect(screen.getByTestId('running-proposal').textContent).toMatch(/Could not compute/)
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
  })
})
