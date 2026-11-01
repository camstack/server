// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * Data → Migrations: the table joins ledger and pending rows, an unanswered
 * query is progress (never "no migrations"), and a row opens every field.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityPresence } from '../../../../lib/capability-presence'

expect.extend(jestDomMatchers)

interface QueryState {
  data?: unknown
  isError?: boolean
  error?: { message: string }
}
let presence: CapabilityPresence = 'present'
let ledger: QueryState = {}
let pending: QueryState = {}
const dryRunRefetch = vi.fn()

vi.mock('../../../../lib/capability-presence', () => ({ useCapabilityPresence: () => presence }))
vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    trpc: {
      migrations: {
        listLedger: { useQuery: () => ledger },
        listPending: { useQuery: () => pending },
        dryRun: {
          useQuery: () => ({
            refetch: dryRunRefetch,
            isFetching: false,
            isError: false,
            data: undefined,
          }),
        },
      },
    },
  }
})

import { MigrationsSection } from '../MigrationsSection'

const meta = (id: string, owner: string, bodyKind: string, dependsOn: string[] = []) => ({
  id,
  owner,
  level: owner === 'hub' ? 'hub-store' : 'addon-state',
  seq: 1,
  dependsOn,
  store: 'settings',
  scope: 'cluster',
  onFailure: 'block-owner',
  bodyKind,
  description: `does ${id}`,
  fixtureMark: 'mark',
})
const HUB = 'hub/2026-10-02-a'
const ADDON = 'ex/2026-10-05-b'
const WAIT = 'hub/2026-10-08-c'
const BAD = 'ex/2026-10-07-d'

const entry = (id: string, owner: string, status: string, extra = {}) => ({
  id,
  database: 'settings',
  owner,
  level: 'hub-store',
  seq: 1,
  status,
  attempts: 1,
  appliedAt: 1_700_000_000_000,
  codeVersion: '1.2.3',
  planSummary: null,
  progress: null,
  error: null,
  reason: null,
  nodeId: 'hub',
  bootId: 'bootx',
  ...extra,
})

function answerAll(): void {
  ledger = {
    data: {
      entries: [
        { ...entry(HUB, 'hub', 'applied'), meta: meta(HUB, 'hub', 'sql') },
        { ...entry(ADDON, 'ex', 'applied'), meta: meta(ADDON, 'ex', 'procedure') },
        {
          ...entry(BAD, 'ex', 'failed', { error: 'precondition mismatch', appliedAt: null }),
          meta: meta(BAD, 'ex', 'plan', [ADDON]),
        },
      ],
    },
  }
  pending = {
    data: {
      pending: [
        {
          meta: meta(WAIT, 'hub', 'sql', [HUB]),
          database: 'events',
          state: 'pending',
          reason: null,
        },
      ],
    },
  }
}

const renderSection = () =>
  render(
    <MemoryRouter>
      <MigrationsSection />
    </MemoryRouter>,
  )

describe('MigrationsSection', () => {
  afterEach(() => {
    presence = 'present'
    ledger = {}
    pending = {}
    vi.clearAllMocks()
  })

  it('shows progress, not an empty state, while the queries have not answered', () => {
    renderSection()
    expect(screen.getByRole('status')).toHaveTextContent(/loading migrations/i)
    expect(screen.queryByText('No migrations.')).toBeNull()
  })

  it('says the capability is absent only when the registry answered absent', () => {
    presence = 'absent'
    renderSection()
    expect(screen.getByText(/no migration ledger on this hub/i)).toBeInTheDocument()
  })

  it('an unreachable registry is an error, not "absent"', () => {
    presence = 'unknown'
    renderSection()
    expect(screen.getByText(/could not check the migration ledger/i)).toBeInTheDocument()
    expect(screen.queryByText(/no migration ledger/i)).toBeNull()
  })

  it('a failed read is an error', () => {
    ledger = { isError: true, error: { message: 'boom' } }
    renderSection()
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('answered with nothing is the empty state', () => {
    ledger = { data: { entries: [] } }
    pending = { data: { pending: [] } }
    renderSection()
    expect(screen.getAllByText('No migrations.').length).toBeGreaterThan(0)
  })

  it('lists ledger and pending migrations together with their status', () => {
    answerAll()
    renderSection()
    for (const id of [HUB, ADDON, WAIT, BAD]) expect(screen.getByText(id)).toBeInTheDocument()
    expect(screen.getAllByText('Applied').length).toBeGreaterThan(0)
    expect(screen.getByText('Pending', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0)
  })

  it('a row opens the detail with the error, meta and linked dependencies', () => {
    answerAll()
    renderSection()
    fireEvent.click(screen.getByText(BAD))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByTestId('migration-error')).toHaveTextContent('precondition mismatch')
    expect(within(dialog).getByText('does ' + BAD)).toBeInTheDocument()
    expect(within(dialog).getByText('plan')).toBeInTheDocument()
    // The dependency is a known row: it is a link to it.
    fireEvent.click(within(dialog).getByRole('button', { name: ADDON }))
    expect(within(screen.getByRole('dialog')).getByText('procedure')).toBeInTheDocument()
  })

  it('offers the dry run for a hub sql migration only', () => {
    answerAll()
    renderSection()
    fireEvent.click(screen.getByText(HUB))
    expect(screen.getByRole('button', { name: /run a dry run/i })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(screen.getByText(ADDON))
    expect(screen.queryByRole('button', { name: /run a dry run/i })).toBeNull()
  })
})
