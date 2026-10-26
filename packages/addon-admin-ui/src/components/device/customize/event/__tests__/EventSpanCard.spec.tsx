import { DeviceType } from '@camstack/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import type { CandidateDevice } from '../../assignments/assignment-candidates'
import type { CameraSensorsRead } from '../../use-camera-sensors-presence'

const CAMERA = {
  id: 101,
  name: 'Front camera',
  addonId: 'provider-onvif',
  stableId: 'camera.front',
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

const MOTION: CandidateDevice = {
  id: 301,
  name: 'Motion',
  addonId: 'provider-homeassistant',
  stableId: 'binary_sensor.veranda',
  type: 'binary_sensor',
  location: 'Veranda',
  isCamera: false,
  integration: null,
  parentDeviceId: 399,
}

const PARENT: CandidateDevice = {
  id: 399,
  name: 'Sensore movimento veranda',
  addonId: 'provider-homeassistant',
  stableId: 'device.veranda',
  type: 'hub',
  location: 'Veranda',
  isCamera: false,
  integration: null,
  parentDeviceId: null,
}

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useAddonSettingsGetDeviceSettings: () => ({ data: undefined }),
    usePipelineOrchestratorApplyDeviceSettingsPatch: () => ({ isPending: false }),
    usePipelineOrchestratorSetCameraSensors: () => ({ isPending: false }),
  }
})

vi.mock('../../assignments/use-live-value', () => ({
  useLiveValue: () => ({ kind: 'pending' as const }),
}))

vi.mock('../../assignments/use-source-candidates', () => ({
  useCandidateDevices: () => ({ kind: 'known' as const, value: [MOTION, PARENT] }),
}))

const { EventSpanCard } = await import('../EventSpanCard')

const VIEW = {
  id: 'detected',
  timeoutMs: 30_000,
  cooldownMs: null,
  sourceModes: ['in-addition', 'confirm', 'replace'] as const,
  deviceTypes: [DeviceType.Camera],
}

function unread(failureReason: string | null): CameraSensorsRead {
  return {
    presence: 'unknown',
    status: null,
    failureReason,
    refetch: async () => 'answered',
  }
}

describe('EventSpanCard', () => {
  it('names a child sensor with its parent', () => {
    render(
      <EventSpanCard
        device={CAMERA}
        availability={{ kind: 'present', mode: 'add' }}
        cap="motion"
        title="Motion"
        view={VIEW}
        sensors={{
          presence: 'present',
          failureReason: null,
          refetch: async () => 'answered',
          status: {
            state: 'configured',
            sensors: [
              {
                state: 'ready',
                addonId: MOTION.addonId,
                stableId: MOTION.stableId,
                mode: 'confirm',
                deviceId: 301,
                name: 'Motion',
                caps: ['motion'],
              },
            ],
          },
        }}
      />,
    )
    expect(screen.getByText('Motion · Sensore movimento veranda')).toBeTruthy()
  })

  it('does not render an empty reason after the sensors could not be read', () => {
    render(
      <EventSpanCard
        device={CAMERA}
        availability={{ kind: 'unknown', reason: '   ' }}
        cap="motion"
        title="Motion"
        view={VIEW}
        sensors={unread(null)}
      />,
    )
    expect(screen.getByText('The attached sensors could not be read.')).toBeTruthy()
    expect(screen.queryByText(/could not be read:/)).toBeNull()
  })
})
