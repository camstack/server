import type { SystemTrpcClient } from '@camstack/ui-library'
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DeviceDetailModule } from '../DeviceDetailModule'
import { buildModel, WASHER_SLICES } from '../hero/__tests__/fixtures'

/** A client that answers each tRPC path from a table and nothing else - no System behind it. */
function clientAnswering(answers: Readonly<Record<string, unknown>>): SystemTrpcClient {
  const link: TRPCLink<never> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') return () => undefined
        observer.next({ result: { type: 'data', data: answers[op.path] ?? null } } as never)
        observer.complete()
        return () => undefined
      })
  // The links accept any router shape: the harness is a stand-in for the hub.
  return createTRPCClient({ links: [link] }) as unknown as SystemTrpcClient
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
