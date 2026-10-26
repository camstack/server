import { DeviceType } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { DISHWASHER } from '../../../../../../../types/src/composition/customize/__fixtures__/refs.js'

const HOST = {
  id: 101,
  name: 'Front camera',
  addonId: DISHWASHER.addonId,
  stableId: DISHWASHER.stableId,
  type: DeviceType.Camera,
  location: 'Porch',
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: true,
  config: {},
}
const SWITCH = {
  id: 201,
  name: 'Porch switch',
  addonId: 'provider-homeassistant',
  stableId: 'switch.porch',
  type: 'switch',
  location: 'Porch',
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}
const LIGHT = {
  id: 202,
  name: 'Garage light',
  addonId: 'provider-homeassistant',
  stableId: 'light.garage',
  type: 'light',
  location: 'Garage',
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}

vi.mock('../../assignments/use-cap-index', () => ({
  useCapIndex: () => ({
    kind: 'known' as const,
    value: new Map<number, readonly string[]>([[201, ['switch']]]),
  }),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerListAll: () => ({ status: 'success', data: [HOST, SWITCH, LIGHT] }),
    useDeviceManagerGetWireableFields: ({ deviceId }: { deviceId: number }) =>
      deviceId === 201
        ? {
            status: 'success' as const,
            data: {
              caps: [
                {
                  cap: 'switch',
                  fields: [
                    { path: 'on', kind: 'boolean' as const },
                    { path: 'lastChangedAt', kind: 'number' as const },
                  ],
                },
              ],
            },
          }
        : { status: 'success' as const, data: { caps: [] } },
    useDeviceStateGetSnapshot: () => ({ status: 'success' as const, data: {} }),
    DevicePicker: (p: {
      devices: readonly { id: number; name: string }[]
      onChange: (ids: number[]) => void
    }) => (
      <div data-testid="event-pulse-picker">
        {p.devices.map((device) => (
          <button key={device.id} type="button" onClick={() => p.onChange([device.id])}>
            {device.name}
          </button>
        ))}
      </div>
    ),
  }
})

const { EventPulseDialog } = await import('../EventPulseDialog')

describe('EventPulseDialog', () => {
  it('hides incompatible devices behind disclosure and adds a switch source', () => {
    render(
      <EventPulseDialog
        open
        mode="add"
        title="Doorbell"
        cap="doorbell"
        targetId="pressed"
        host={HOST}
        target={DISHWASHER}
        enabled
        debounceMs={2000}
        edges={['rising']}
        edge="rising"
        sources={[]}
        canSave
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Add Doorbell' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Garage light/ })).toBeNull()
    expect(screen.getByTestId('source-incompatible-devices')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /1 not compatible/i }))
    expect(screen.getByText('Garage light')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Porch switch/ }))
    fireEvent.click(screen.getByTestId('source-value-switch.on'))
    expect(screen.getByTestId('source-picked-list')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
  })
})
