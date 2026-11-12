/**
 * The automation device pickers run the REAL library picker over a fake search
 * hub whose fleet holds a container: a container is never a pick (D356), so the
 * event-trigger picker must leave it out while offering the rest. The command
 * step's modal lists the fleet itself: its container case is in
 * `source-selector-action.spec.tsx`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'

vi.mock('../../../../../../ui-library/src/contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: { listSiteZones: { query: () => new Promise(() => undefined) } },
    },
  }),
}))

import { DeviceSearchTrpc, SEARCH_HUB_FLEET } from '../../../../test-setup/device-search-hub'
import { DeviceEventFields } from '../EventFields'

function withHub(ui: ReactElement): ReactElement {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DeviceSearchTrpc fleet={SEARCH_HUB_FLEET}>{ui}</DeviceSearchTrpc>
    </QueryClientProvider>
  )
}

async function openAndList(testId: string): Promise<void> {
  const [trigger] = within(screen.getByTestId(testId)).getAllByRole('button')
  if (trigger === undefined) throw new Error(`no picker trigger in ${testId}`)
  fireEvent.click(trigger)
  await screen.findByRole('option', { name: /Porch light/ })
}

describe('automation device pickers never offer a container', () => {
  it('the event trigger offers devices but not the container', async () => {
    render(
      withHub(
        <DeviceEventFields leaf={{ kind: 'device-event', category: '' }} onChange={() => {}} />,
      ),
    )
    await openAndList('trigger-event-device')
    expect(screen.getByRole('option', { name: /Kitchen/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Hall hub/ })).toBeNull()
  })
})
