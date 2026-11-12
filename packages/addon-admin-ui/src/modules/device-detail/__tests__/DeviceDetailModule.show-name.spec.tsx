import { DeviceType } from '@camstack/types'
import type { SystemTrpcClient } from '@camstack/ui-library'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeviceDetailModule } from '../DeviceDetailModule'
import { fakeSystemClient } from './fake-system-client'

interface NamedProps {
  readonly showName?: boolean
}

// Both renderers stand in as probes: the spec is about what the module hands
// them, not about how they draw a name (their own specs cover that).
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    ConnectedDeviceCard: ({ showName }: NamedProps) => (
      <p data-testid="card-probe">{String(showName)}</p>
    ),
    ModelHero: ({ showName }: NamedProps) => <p data-testid="hero-probe">{String(showName)}</p>,
  }
})

function clientAnswering(answers: Readonly<Record<string, unknown>>): SystemTrpcClient {
  return fakeSystemClient((call) => ({ kind: 'data', value: answers[call.path] ?? null }))
}

const PLUG = {
  'deviceManager.getDevice': { id: 7, name: 'Heater plug', type: DeviceType.Switch },
  'deviceManager.getBindings': { entries: [{ capName: 'switch' }] },
}
// A lock has no device card yet, so the module still draws its hero.
const LOCK = {
  'deviceManager.getDevice': { id: 7, name: 'Front door', type: 'lock' },
  'deviceManager.getBindings': { entries: [{ capName: 'lock' }] },
}

describe('DeviceDetailModule — showName reaches whichever card draws the device', () => {
  it('the device card (plug, climate) gets showName=false from the host', async () => {
    render(
      <DeviceDetailModule
        deviceId={7}
        trpcClient={clientAnswering(PLUG)}
        theme="light"
        locale="en"
        showName={false}
      />,
    )
    expect((await screen.findByTestId('card-probe')).textContent).toBe('false')
  })

  it('the device card names the device when the host says nothing', async () => {
    render(
      <DeviceDetailModule
        deviceId={7}
        trpcClient={clientAnswering(PLUG)}
        theme="light"
        locale="en"
      />,
    )
    expect((await screen.findByTestId('card-probe')).textContent).toBe('true')
  })

  it('the hero gets showName=false from the host', async () => {
    render(
      <DeviceDetailModule
        deviceId={7}
        trpcClient={clientAnswering(LOCK)}
        theme="light"
        locale="en"
        showName={false}
      />,
    )
    expect((await screen.findByTestId('hero-probe')).textContent).toBe('false')
  })
})
