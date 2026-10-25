/// <reference types="@testing-library/jest-dom" />

import { ConfirmDialogProvider, trpc } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * StorageMigrationSection — the presence gate, at the TRANSPORT.
 *
 * Two defects were reported together on 2026-08-31 ("Management stayed ~10s on
 * «no recorder manager installed»"), and each needs an assertion the other
 * cannot make. Both are pinned here, against the REAL tRPC client, because the
 * sibling spec (`StorageMigrationSection.spec.tsx`) mocks the gate hook and a
 * mocked hook can neither be pending nor be observed making a request.
 *
 *  1. **Pending is not absent.** While the answer is in flight the panel must
 *     not tell the operator the capability is *not installed*. `undefined`
 *     coalesced to `[]` and then tested for membership reads exactly like
 *     "nobody has it" — which is how a healthy hub got called broken for ten
 *     seconds. Only an ANSWER carrying no provider may render the absent copy.
 *
 *  2. **The request is proportionate to the question.** The gate used to ride
 *     `nodes.topology`, whose handler fans out across the cluster (per-node
 *     `$agent.status` + `$process.list`, a `ps` sample of every child pid, a
 *     durable history snapshot per online node) and measured 32.4–51.1 s on
 *     the production hub against 0.15 s for the targeted registry read. The
 *     assertion is on the REQUESTS MADE, never on wall clock — a timing
 *     assertion flakes in CI and, worse, would still pass if the fan-out came
 *     back under a fast local fake.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen, waitFor } from '@testing-library/react'
import { httpLink } from '@trpc/client'
import superjson from 'superjson'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StorageMigrationSection } from '../StorageMigrationSection'

expect.extend(jestDomMatchers)

const ABSENT_COPY = /not installed/i
const PENDING_COPY = /checking whether storage migration is installed/i

/** How a held-open request is eventually settled. */
type Settlement = { readonly ok: true; readonly data: unknown } | { readonly ok: false }

/** One in-flight tRPC operation, held open until the test settles it. */
interface InFlight {
  readonly path: string
  readonly settle: (settlement: Settlement) => void
}

let requested: string[] = []
let inFlight: InFlight[] = []

/**
 * A `fetch` that records the tRPC procedure path and then BLOCKS until the
 * test settles it. Blocking is the point: it is the only way to observe the
 * render the operator actually saw — the one before the answer arrives.
 */
const recordingFetch: typeof fetch = async (input) => {
  const raw = input instanceof Request ? input.url : String(input)
  const url = new URL(raw, 'http://test')
  const path = url.pathname.replace(/^\/trpc\//, '')
  requested.push(path)
  const settlement = await new Promise<Settlement>((resolve) => {
    inFlight.push({ path, settle: resolve })
  })
  if (!settlement.ok) {
    return new Response(
      JSON.stringify({ error: { message: 'registry unreachable', code: -32603, data: {} } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  }
  return new Response(JSON.stringify({ result: { data: superjson.serialize(settlement.data) } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function take(path: string): InFlight {
  const pending = inFlight.find((op) => op.path === path)
  if (!pending) throw new Error(`no in-flight request for ${path}; saw: ${requested.join(', ')}`)
  inFlight = inFlight.filter((op) => op !== pending)
  return pending
}

function answer(path: string, data: unknown): void {
  take(path).settle({ ok: true, data })
}

function failRequest(path: string): void {
  take(path).settle({ ok: false })
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = trpc.createClient({
    links: [httpLink({ url: 'http://test/trpc', transformer: superjson, fetch: recordingFetch })],
  })
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ConfirmDialogProvider>
          <StorageMigrationSection />
        </ConfirmDialogProvider>
      </QueryClientProvider>
    </trpc.Provider>,
  )
}

/** The registry row for a capability nobody provides vs one somebody does. */
const REGISTERED = {
  name: 'storage-migration',
  mode: 'singleton',
  providers: ['storage-orchestrator'],
  activeProvider: 'storage-orchestrator',
  disabledProviders: [],
  perNode: [
    {
      nodeId: 'hub',
      providers: ['storage-orchestrator'],
      resolvedActive: 'storage-orchestrator',
      hasOverride: false,
    },
  ],
}
const DECLARED_BUT_UNPROVIDED = {
  name: 'storage-migration',
  mode: 'singleton',
  providers: [],
  activeProvider: null,
  disabledProviders: [],
  perNode: [],
}

describe('StorageMigrationSection — pending is not absent', () => {
  beforeEach(() => {
    requested = []
    inFlight = []
  })
  afterEach(() => {
    // Never leave a blocked fetch hanging past the test that opened it.
    for (const op of inFlight) op.settle({ ok: true, data: null })
    inFlight = []
  })

  it('renders a pending state, not the not-installed claim, while the answer is in flight', async () => {
    renderSection()
    await waitFor(() => {
      expect(requested.length).toBeGreaterThan(0)
    })
    expect(screen.queryByText(ABSENT_COPY)).not.toBeInTheDocument()
    expect(screen.getByText(PENDING_COPY)).toBeInTheDocument()
  })

  it('claims absent only once the registry has ANSWERED with no provider', async () => {
    renderSection()
    await waitFor(() => {
      expect(requested.length).toBeGreaterThan(0)
    })
    answer('capabilities.getCapability', null)
    await waitFor(() => {
      expect(screen.getByText(ABSENT_COPY)).toBeInTheDocument()
    })
    expect(screen.queryByText(PENDING_COPY)).not.toBeInTheDocument()
  })

  it('treats a declared-but-unprovided capability as absent, not as present', async () => {
    renderSection()
    await waitFor(() => {
      expect(requested.length).toBeGreaterThan(0)
    })
    answer('capabilities.getCapability', DECLARED_BUT_UNPROVIDED)
    await waitFor(() => {
      expect(screen.getByText(ABSENT_COPY)).toBeInTheDocument()
    })
  })

  /**
   * A FAILED read is not an answer either, so it may not produce the absent
   * copy. It gets its own words — an operator who cannot reach the registry is
   * owed "I could not check", not "it is not there".
   */
  it('says it could not check — never that it is absent — when the read fails', async () => {
    renderSection()
    await waitFor(() => {
      expect(requested.length).toBeGreaterThan(0)
    })
    failRequest('capabilities.getCapability')
    await waitFor(() => {
      expect(
        screen.getByText(/couldn't check whether storage migration is installed/i),
      ).toBeInTheDocument()
    })
    expect(screen.queryByText(ABSENT_COPY)).not.toBeInTheDocument()
  })

  it('renders the panel once the registry answers with a provider', async () => {
    renderSection()
    await waitFor(() => {
      expect(requested.length).toBeGreaterThan(0)
    })
    answer('capabilities.getCapability', REGISTERED)
    await waitFor(() => {
      expect(screen.getByText('Storage migration')).toBeInTheDocument()
    })
    expect(screen.queryByText(ABSENT_COPY)).not.toBeInTheDocument()
  })
})

describe('StorageMigrationSection — the gate asks one targeted question', () => {
  beforeEach(() => {
    requested = []
    inFlight = []
  })
  afterEach(() => {
    for (const op of inFlight) op.settle({ ok: true, data: null })
    inFlight = []
  })

  /**
   * The SHAPE assertion: one round trip, to the capability registry, for the
   * one capability this panel needs. `nodes.topology` is named explicitly
   * because it is the endpoint the gate used to ride and the one whose cost
   * scales with the cluster rather than with the answer.
   */
  it('asks the registry for ONE capability and never the cluster topology', async () => {
    renderSection()
    await waitFor(() => {
      expect(requested.length).toBeGreaterThan(0)
    })
    expect(requested).toEqual(['capabilities.getCapability'])
    expect(requested).not.toContain('nodes.topology')
  })

  it('names the capability in the request rather than filtering a fleet-wide answer', async () => {
    renderSection()
    await waitFor(() => {
      expect(requested.length).toBeGreaterThan(0)
    })
    expect(requested).not.toContain('capabilities.listCapabilities')
  })

  /**
   * A gate that resolved to "absent" must not keep asking. The old topology
   * read was re-issued by every consumer that mounted; the replacement is a
   * single settled query for as long as the panel is on screen.
   */
  it('does not re-ask after the registry has answered', async () => {
    renderSection()
    await waitFor(() => {
      expect(requested.length).toBeGreaterThan(0)
    })
    answer('capabilities.getCapability', null)
    await waitFor(() => {
      expect(screen.getByText(ABSENT_COPY)).toBeInTheDocument()
    })
    expect(requested).toEqual(['capabilities.getCapability'])
  })
})
