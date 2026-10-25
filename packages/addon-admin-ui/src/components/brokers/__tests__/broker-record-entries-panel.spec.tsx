/**
 * A broker kind served through the generic record-entries panel keeps what the
 * hand-built broker table had: a status per row and Sign in / Sign out where the
 * provider advertises an interactive connect path. Generic: the paths come from
 * `broker.listProviders`, never from an addon id.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { EntryView } from '@camstack/types'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const startConnect = vi.fn()
vi.mock('../../../lib/broker-oauth-popup', () => ({
  startBrokerInteractiveConnect: (...args: unknown[]) => startConnect(...args),
}))

const KIND = {
  owner: 'google-services',
  kind: 'brokers',
  title: 'Google accounts',
  nameField: 'name',
  fields: {},
  secretPaths: [],
  rows: 2,
}

const ENTRIES: readonly EntryView[] = ['google_001', 'google_002', 'google_003'].map((id) => ({
  id,
  name: id,
  rev: 1,
  updatedAt: 1,
  data: {},
}))

const state = vi.hoisted(() => ({
  brokers: [] as readonly Record<string, unknown>[],
  providers: [] as readonly Record<string, unknown>[],
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useRecordEntriesListEntryKinds: () => ({
      isPending: false,
      isError: false,
      data: { kinds: [KIND] },
    }),
    useBrokerList: () => ({ data: state.brokers }),
    useBrokerListProviders: () => ({ data: state.providers }),
    RecordEntriesPanel: (props: {
      rowActions?: (e: EntryView) => ReactNode
      extraColumns?: readonly { key: string; render: (e: EntryView) => ReactNode }[]
    }) => (
      <div>
        {ENTRIES.map((e) => (
          <div key={e.id} data-testid={`row-${e.id}`}>
            {props.extraColumns?.map((c) => (
              <span key={c.key}>{c.render(e)}</span>
            ))}
            {props.rowActions?.(e)}
          </div>
        ))}
      </div>
    ),
  }
})

import { BrokerRecordEntriesPanel } from '../BrokerRecordEntriesPanel'

const broker = (id: string, status: string, kind = 'google') => ({
  id,
  addonId: 'google-services',
  name: id,
  kind,
  status,
  info: {},
  lastCheckedAt: null,
  error: null,
})

beforeEach(() => {
  startConnect.mockClear()
  state.providers = [
    {
      addonId: 'google-services',
      kinds: [
        {
          kind: 'google',
          label: 'Google',
          interactiveConnectPath: '/addon/google-services/oauth/start?brokerId={{brokerId}}',
          interactiveDisconnectPath:
            '/addon/google-services/oauth/disconnect?brokerId={{brokerId}}',
        },
        { kind: 'plain', label: 'Plain' },
      ],
    },
  ]
  state.brokers = [
    broker('google_001', 'auth-failed'),
    broker('google_002', 'connected'),
    broker('google_003', 'disconnected', 'plain'),
  ]
})

function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BrokerRecordEntriesPanel addonId="google-services" fallback={<div>fallback</div>} />
    </QueryClientProvider>,
  )
}

describe('BrokerRecordEntriesPanel row actions', () => {
  it('a broker that needs a new sign-in shows its status and Sign in, and opens the advertised path', () => {
    renderPanel()
    const row = screen.getByTestId('row-google_001')
    expect(row.textContent).toContain('auth-failed')
    expect(row.querySelector('button')?.textContent).toMatch(/Sign in/)
    fireEvent.click(row.querySelector('button')!)
    expect(startConnect).toHaveBeenCalledWith(
      '/addon/google-services/oauth/start?brokerId={{brokerId}}',
      'google_001',
      expect.any(Function),
    )
  })

  it('a connected broker offers Sign out, not Sign in', () => {
    renderPanel()
    const row = screen.getByTestId('row-google_002')
    expect(row.textContent).toContain('connected')
    const buttons = [...row.querySelectorAll('button')].map((b) => b.textContent ?? '')
    expect(buttons.some((t) => /Sign out/.test(t))).toBe(true)
    expect(buttons.some((t) => /Sign in/.test(t))).toBe(false)
    fireEvent.click(
      [...row.querySelectorAll('button')].find((b) => /Sign out/.test(b.textContent ?? ''))!,
    )
    expect(startConnect).toHaveBeenCalledWith(
      '/addon/google-services/oauth/disconnect?brokerId={{brokerId}}',
      'google_002',
      expect.any(Function),
    )
  })

  it('a kind with no interactive path gets no sign-in buttons', () => {
    renderPanel()
    expect(screen.getByTestId('row-google_003').querySelectorAll('button')).toHaveLength(0)
  })

  it('a row the broker list has not answered for shows no actions (unknown is not absent)', () => {
    state.brokers = []
    renderPanel()
    expect(screen.getByTestId('row-google_001').querySelectorAll('button')).toHaveLength(0)
  })
})
