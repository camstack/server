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
const GARAGE = {
  ...METER,
  id: 304,
  name: 'Garage lamp',
  stableId: 'lamp',
  location: 'Garage',
}

const fleet = vi.hoisted(() => ({
  current: { status: 'pending' } as { status: string; data?: unknown[] },
}))

vi.mock('../../assignments/use-cap-index', () => ({
  useCapIndex: () => ({
    kind: 'known' as const,
    value: new Map<number, readonly string[]>([[305, ['power-meter']]]),
  }),
}))

// The REAL DeviceValueField runs here (its step logic is the subject); only its device list,
// which needs the system provider for grouping, is replaced.
vi.mock('../../../../../../../ui-library/src/composites/device-picker/DevicePicker', () => ({
  DevicePicker: (p: { devices: readonly { id: number; name: string }[] }) => (
    <div>
      {p.devices.map((device) => (
        <span key={device.id}>{device.name}</span>
      ))}
    </div>
  ),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useCoreBlocksProposeRunningThreshold: () => ({ status: 'pending' }),
    useDeviceManagerListAll: () => fleet.current,
    useDeviceManagerGetWireableFields: ({ deviceId }: { deviceId: number }) =>
      deviceId === 305
        ? {
            status: 'success' as const,
            data: {
              caps: [
                {
                  cap: 'power-meter',
                  fields: [{ path: 'power', kind: 'number' as const }],
                },
              ],
            },
          }
        : { status: 'success' as const, data: { caps: [] } },
    useDeviceStateGetSnapshot: ({ deviceId }: { deviceId: number }) =>
      deviceId === 305
        ? {
            status: 'success' as const,
            data: { 'power-meter': { power: 8.4, unit: 'W' } },
          }
        : { status: 'success' as const, data: {} },
  }
})

const { ScalarOverrideDialog } = await import('../ScalarOverrideDialog')

function dialog() {
  return (
    <ScalarOverrideDialog
      open
      mode="change"
      title="Running"
      cap="running-state"
      targetId="running"
      host={HOST}
      target={DISHWASHER}
      apply="replace"
      seed={{
        source: {
          addonId: METER.addonId,
          stableId: METER.stableId,
          cap: 'power-meter',
          fieldPath: 'power',
          valueKind: 'number',
          sourceUnit: 'W',
          changedAtField: null,
        },
        transform: {
          kind: 'threshold',
          comparison: 'gte',
          threshold: 7,
          startDwellMs: 90_000,
          stopDwellMs: 600_000,
        },
      }}
      canSave
      onClose={() => undefined}
      onSave={() => undefined}
    />
  )
}

describe('ScalarOverrideDialog change mode, fleet answering after mount', () => {
  it('shows the editable threshold fields once the seeded device resolves', () => {
    fleet.current = { status: 'pending' }
    const { rerender } = render(dialog())
    fleet.current = { status: 'success', data: [HOST, METER] }
    rerender(dialog())
    expect(screen.getByTestId('source-selector').getAttribute('data-step')).toBe('preview')
    expect(screen.getByTestId('source-selector-preview').className).not.toContain('hidden')
    expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(0)
  })
})
