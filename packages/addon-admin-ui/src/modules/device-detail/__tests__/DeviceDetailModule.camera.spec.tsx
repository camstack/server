import { DeviceFeature, DeviceType } from '@dominevo/types'
import type { SystemTrpcClient } from '@dominevo/ui-library'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DeviceDetailModule } from '../DeviceDetailModule'
import { fakeSystemClient, type FakeAnswer } from './fake-system-client'

interface SceneProps {
  readonly stillFirst?: boolean
  readonly intercomAvailable?: boolean
}

// The camera card and the hero stand in as probes: the spec is about WHICH
// body the module routes a device to, and what it hands the camera's scene.
vi.mock('@dominevo/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dominevo/ui-library')>()
  return {
    ...actual,
    ConnectedCameraCard: ({ scene }: { readonly scene: ReactNode }) => (
      <div data-testid="camera-card">{scene}</div>
    ),
    ModelHero: () => <p data-testid="hero-probe" />,
  }
})
vi.mock('../../../components/device/PanelContent', () => ({
  StreamPanelContent: ({ stillFirst, intercomAvailable }: SceneProps) => (
    <p data-testid="scene-probe">{`${String(stillFirst)}/${String(intercomAvailable)}`}</p>
  ),
}))

function client(answers: Readonly<Record<string, FakeAnswer>>): SystemTrpcClient {
  return fakeSystemClient((call) => answers[call.path] ?? { kind: 'data', value: null })
}

const data = (value: unknown): FakeAnswer => ({ kind: 'data', value })

function draw(answers: Readonly<Record<string, FakeAnswer>>): void {
  render(<DeviceDetailModule deviceId={7} trpcClient={client(answers)} theme="light" locale="en" />)
}

describe('DeviceDetailModule — a camera goes through the camera card', () => {
  it('routes a camera to the camera card with a still-first scene', async () => {
    draw({
      'deviceManager.getDevice': data({
        id: 7,
        name: 'Garden',
        type: DeviceType.Camera,
        features: [DeviceFeature.TwoWayAudio],
      }),
      'deviceManager.getBindings': data({ entries: [] }),
    })
    expect(await screen.findByTestId('camera-card')).toBeTruthy()
    expect(screen.getByTestId('scene-probe').textContent).toBe('true/true')
  })

  it('draws a skeleton, not the hero, while the device is still loading', () => {
    draw({ 'deviceManager.getDevice': { kind: 'hang' } })
    expect(screen.queryByTestId('hero-probe')).toBeNull()
    expect(screen.queryByTestId('camera-card')).toBeNull()
  })

  it('keeps the old path for a device that is not a camera', async () => {
    draw({
      'deviceManager.getDevice': data({ id: 7, name: 'Front door', type: 'lock' }),
      'deviceManager.getBindings': data({ entries: [{ capName: 'lock' }] }),
    })
    expect(await screen.findByTestId('hero-probe')).toBeTruthy()
    expect(screen.queryByTestId('camera-card')).toBeNull()
  })
})
