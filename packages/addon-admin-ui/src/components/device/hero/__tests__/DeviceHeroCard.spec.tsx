// @vitest-environment jsdom
/**
 * The device card the quick-detail modal opens on is the viewer's: the hero model
 * with its consumables chip and its History button, and no legacy fallback when
 * the model draws nothing. Mounted with the real module over a stand-in hub.
 */
import { buildHeroModel } from '@camstack/types'
import { ThemeProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'

const NOW = 1_700_000_000_000
const WASHER = buildHeroModel({
  device: { id: 7, type: 'washer', role: null, name: 'Washer', online: true },
  caps: ['running-state', 'consumables'],
  features: [],
  slices: {
    'running-state': {
      running: true,
      since: NOW - 60_000,
      source: 'native',
      phase: 'Rinse',
      lastFetchedAt: NOW,
    },
    consumables: {
      items: [
        {
          key: 'detergent',
          label: 'Detergent',
          level: 12,
          status: 'low',
          lastResetAt: null,
          resettable: false,
        },
      ],
      lastChangedAt: NOW,
    },
  },
  now: NOW,
  remoteCommands: null,
  access: { canActuate: true },
})

const hub = vi.hoisted(() => ({ model: null as unknown }))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const { fakeSystemClient } = await import(
    '../../../../modules/device-detail/__tests__/fake-system-client'
  )
  const client = fakeSystemClient((call) => {
    if (call.path === 'heroLayout.getHeroModel') return { kind: 'data', value: hub.model }
    if (call.path === 'capabilities.getCapability') {
      const name = 'device-history'
      return {
        kind: 'data',
        value: {
          name,
          mode: 'singleton',
          providers: [name],
          activeProvider: name,
          disabledProviders: [],
        },
      }
    }
    if (call.path === 'deviceManager.getBindings') {
      return { kind: 'data', value: { entries: [{ capName: 'running-state' }] } }
    }
    if (call.path === 'deviceHistory.listSeries') {
      return {
        kind: 'data',
        value: [
          {
            key: 'cap:running-state.running',
            scope: '',
            kind: 'gauge',
            unit: '',
            displayName: 'Running',
          },
        ],
      }
    }
    return { kind: 'data', value: null }
  })
  return { ...actual, useSystem: () => ({ trpcClient: client }) }
})
vi.mock('../../../../contexts/auth-context', () => ({
  useAuth: () => ({ user: { isAdmin: true } }),
}))

import { DeviceHeroCard } from '../DeviceHeroCard'

function mount(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThemeProvider defaultMode="light">
        <MemoryRouter>
          <DeviceHeroCard
            deviceId={7}
            device={{ type: 'washer' }}
            deviceName="Washer"
            legacyFallback={false}
          />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

describe('DeviceHeroCard', () => {
  it('draws consumables and the history button (Cycles for a washer) from the hero model', async () => {
    hub.model = WASHER
    mount()
    expect(await screen.findByText('Consumables')).toBeTruthy()
    expect(await screen.findByText('Cycles')).toBeTruthy()
  })

  it('draws no legacy hero when the model covers nothing and the fallback is off', async () => {
    hub.model = null
    mount()
    await screen.findByTestId('device-detail-module')
    expect(screen.queryByText('Washer')).toBeNull()
  })
})
