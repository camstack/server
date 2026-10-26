import { DeviceType } from '@camstack/types'
import { render, screen } from '@testing-library/react'
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

const SENSOR = {
  id: 301,
  name: 'Motion',
  addonId: 'provider-homeassistant',
  stableId: 'binary_sensor.porch',
  type: 'binary_sensor',
  location: 'Porch',
  disabled: false,
  parentDeviceId: 399,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}

const PARENT = {
  id: 399,
  name: 'Porch motion sensor',
  addonId: 'provider-homeassistant',
  stableId: 'device.porch',
  type: 'hub',
  location: 'Porch',
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
    value: new Map<number, readonly string[]>([[301, ['motion']]]),
  }),
}))

interface LiveTarget {
  readonly deviceId: number
  readonly cap: string
  readonly path: string
}

type MockLive = { readonly kind: 'pending' } | { readonly kind: 'value'; readonly value: boolean }

function liveValue(target: LiveTarget | null): MockLive {
  if (target?.deviceId === 301 && target.cap === 'motion' && target.path === 'detected') {
    return { kind: 'value', value: false }
  }
  return { kind: 'pending' }
}

vi.mock('../../assignments/use-live-value', () => ({
  useLiveValue: (target: LiveTarget | null) => liveValue(target),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerListAll: () => ({ status: 'success', data: [HOST, SENSOR, PARENT] }),
    useDeviceManagerGetWireableFields: ({ deviceId }: { deviceId: number }) =>
      deviceId === 301
        ? {
            status: 'success' as const,
            data: {
              caps: [
                {
                  cap: 'device-status',
                  fields: [{ path: 'online', kind: 'boolean' as const }],
                },
                {
                  cap: 'motion',
                  fields: [{ path: 'detected', kind: 'boolean' as const }],
                },
                {
                  cap: 'mqtt-broker',
                  fields: [{ path: 'embeddedRunning', kind: 'boolean' as const }],
                },
              ],
            },
          }
        : { status: 'success' as const, data: { caps: [] } },
    useDeviceStateGetSnapshot: () => ({
      status: 'success' as const,
      data: { motion: { detected: false } },
    }),
    DevicePicker: (p: {
      devices: readonly { id: number; name: string }[]
      value?: readonly number[]
      onChange: (ids: number[]) => void
    }) => (
      <div data-testid="event-span-picker" data-value={(p.value ?? []).join(',')}>
        {p.devices.map((device) => (
          <button key={device.id} type="button" onClick={() => p.onChange([device.id])}>
            {device.name}
          </button>
        ))}
      </div>
    ),
  }
})

const { EventSpanDialog } = await import('../EventSpanDialog')

describe('EventSpanDialog edit', () => {
  it('preselects the stored device and mode, and shows the declared on/off', () => {
    render(
      <EventSpanDialog
        open
        mode="change"
        title="Motion"
        cap="motion"
        targetId="detected"
        host={HOST}
        target={DISHWASHER}
        timeoutMs={30_000}
        cooldownMs={null}
        sourceModes={['in-addition', 'confirm', 'replace']}
        sources={[
          {
            addonId: SENSOR.addonId,
            stableId: SENSOR.stableId,
            cap: 'binary',
            fieldPath: 'on',
            mode: 'confirm',
            label: 'Motion',
          },
        ]}
        canSave
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    )
    expect(screen.getByTestId('event-span-picker').getAttribute('data-value')).toBe('301')
    expect(screen.queryByTestId('source-value-device-status.online')).toBeNull()
    expect(screen.queryByTestId('source-value-mqtt-broker.embeddedRunning')).toBeNull()
    expect(screen.queryByText(/Reachability/)).toBeNull()
    expect(screen.queryByText(/embeddedRunning/)).toBeNull()
    expect(screen.queryByText(/Waiting for the sensor/)).toBeNull()
    const declared = screen.getByTestId('source-declared-field')
    expect(declared.textContent).toMatch(/Motion/)
    expect(declared.textContent).toMatch(/false/)
    expect(screen.getByText('No motion.')).toBeTruthy()
    const mode = screen.getByRole('combobox')
    expect(mode instanceof HTMLSelectElement && mode.value).toBe('confirm')
  })
})
