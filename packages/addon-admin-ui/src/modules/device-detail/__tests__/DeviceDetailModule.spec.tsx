import type { SystemTrpcClient } from '@camstack/ui-library'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DeviceDetailModule } from '../DeviceDetailModule'
import { buildModel, WASHER_SLICES } from '../hero/__tests__/fixtures'
import { fakeSystemClient } from './fake-system-client'

/** A client that answers each tRPC path from a table and nothing else - no System behind it. */
function clientAnswering(answers: Readonly<Record<string, unknown>>): SystemTrpcClient {
  return fakeSystemClient((call) => ({ kind: 'data', value: answers[call.path] ?? null }))
}

const washer = buildModel('washer', ['running-state', 'power-meter'], WASHER_SLICES)

describe('DeviceDetailModule', () => {
  it('draws the hero from props alone, with no System or router mounted', async () => {
    render(
      <DeviceDetailModule
        deviceId={7}
        trpcClient={clientAnswering({
          'heroLayout.getHeroModel': washer,
          'deviceManager.getBindings': { entries: [{ capName: 'running-state' }] },
        })}
        theme="dark"
        locale="en"
      />,
    )
    expect(await screen.findByText('Running')).toBeTruthy()
    expect(screen.getByTestId('device-detail-module').className).toContain('dark')
  })

  it('draws the host fallback while the model does not cover the device', async () => {
    render(
      <DeviceDetailModule
        deviceId={7}
        trpcClient={clientAnswering({ 'deviceManager.getBindings': { entries: [] } })}
        theme="light"
        locale="it"
        fallback={<p>legacy hero</p>}
      />,
    )
    expect(await screen.findByText('legacy hero')).toBeTruthy()
  })
})
