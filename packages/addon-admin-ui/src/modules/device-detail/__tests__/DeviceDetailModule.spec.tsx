import type { SystemTrpcClient } from '@camstack/ui-library'
import { DeviceType } from '@camstack/types'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeviceDetailModule } from '../DeviceDetailModule'
import { WASHER_MODEL } from './washer-model'
import { fakeSystemClient } from './fake-system-client'

/** A client that answers each tRPC path from a table and nothing else - no System behind it. */
function clientAnswering(answers: Readonly<Record<string, unknown>>): SystemTrpcClient {
  return fakeSystemClient((call) => ({ kind: 'data', value: answers[call.path] ?? null }))
}

const washer = WASHER_MODEL

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

  it('hands a plug to the device card instead of the hero or the host fallback', async () => {
    const onDrawn = vi.fn()
    render(
      <DeviceDetailModule
        deviceId={7}
        trpcClient={clientAnswering({
          'deviceManager.getDevice': { id: 7, name: 'Heater plug', type: DeviceType.Switch },
          'deviceManager.getBindings': { entries: [{ capName: 'switch' }] },
        })}
        theme="light"
        locale="en"
        fallback={<p>legacy hero</p>}
        onDrawn={onDrawn}
      />,
    )
    await waitFor(() => expect(onDrawn).toHaveBeenCalledWith(true))
    expect(screen.queryByText('legacy hero')).toBeNull()
  })

  it('keeps the hero for a switch-typed device that binds no switch', async () => {
    render(
      <DeviceDetailModule
        deviceId={7}
        trpcClient={clientAnswering({
          'deviceManager.getDevice': { id: 7, name: 'Heater plug', type: DeviceType.Switch },
          'deviceManager.getBindings': { entries: [] },
        })}
        theme="light"
        locale="en"
        fallback={<p>legacy hero</p>}
      />,
    )
    expect(await screen.findByText('legacy hero')).toBeTruthy()
  })
})
