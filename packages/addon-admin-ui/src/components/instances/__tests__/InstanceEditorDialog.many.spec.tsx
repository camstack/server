/**
 * Create several records in one confirm: a discovered picker that declares `pickManyOnCreate`
 * holds several values on create, and Save makes one record per ticked value, named after the
 * candidate the picker showed. Real hooks and real tRPC clients over a link that answers from
 * this file, so the specs assert on the exact writes the dialog makes.
 *
 * Disarm: send the whole ticked list to one create (drop the many branch) and "two ticks" fails;
 * swallow the error of a create and "stops and says how far" fails; send the array on one tick
 * and "one tick" fails.
 */
import type { System } from '@camstack/sdk'
import type { ConfigSelectField } from '@camstack/types'
import { SystemProvider, trpc } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../brokers/__tests__/setup'
import { InstanceEditorDialog } from '../InstanceEditorDialog'
import { ManyPickLabels } from '../ManyPickLabels'

const ECHO_FIELD: ConfigSelectField = {
  type: 'select',
  key: 'echoId',
  label: 'Echo',
  options: [],
  discoverOptions: { kind: 'alexa-echo', dependsOn: [], pickManyOnCreate: true },
}

const FORM = { sections: [{ id: 's_echo', title: 'Echo', columns: 1, fields: [ECHO_FIELD] }] }

const CANDIDATES = [
  { kind: 'alexa-echo', suggestedName: 'Kitchen', config: { echoId: 'e1' } },
  { kind: 'alexa-echo', suggestedName: 'Hall', config: { echoId: 'e2' } },
]

interface Call {
  readonly path: string
  readonly input: unknown
}

interface Hub {
  readonly calls: Call[]
  readonly link: TRPCLink<never>
}

function makeHub(opts: { failCreateAt?: number; failDiscovery?: boolean } = {}): Hub {
  const calls: Call[] = []
  let creates = 0
  const answer = (path: string, input: unknown): unknown => {
    calls.push({ path, input })
    switch (path) {
      case 'integrationInstances.instanceFormSchema':
        return FORM
      case 'notificationOutput.discoverTargets':
        if (opts.failDiscovery === true) throw new Error('account offline')
        return CANDIDATES
      case 'integrationInstances.createInstance': {
        creates += 1
        if (creates === opts.failCreateAt) throw new Error('boom')
        return { id: `rec-${creates}` }
      }
      case 'integrationInstances.updateInstance':
        return {}
      default:
        return null
    }
  }
  const link: TRPCLink<never> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') return () => undefined
        void Promise.resolve()
          .then(() => answer(op.path, op.input))
          .then(
            (data) => {
              observer.next({ result: { type: 'data', data: data ?? null } } as never)
              observer.complete()
            },
            (err: unknown) => {
              observer.error(
                TRPCClientError.from(err instanceof Error ? err : new Error(String(err))),
              )
            },
          )
        return () => undefined
      })
  return { calls, link }
}

function withHub(hub: Hub, ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = trpc.createClient({ links: [hub.link] })
  // A test boundary: only the tRPC client of the System is used by these components.
  const system = {
    trpcClient: createTRPCClient({ links: [hub.link] }),
    subscribeConnectionEvents: () => () => undefined,
    onEvent: () => () => undefined,
    subscribeEvents: () => () => undefined,
    subscribeEvent: () => () => undefined,
    subscribe: () => () => undefined,
  } as unknown as System
  return render(
    <QueryClientProvider client={queryClient}>
      <trpc.Provider client={client} queryClient={queryClient}>
        <SystemProvider system={system}>{ui}</SystemProvider>
      </trpc.Provider>
    </QueryClientProvider>,
  )
}

function renderCreate(hub: Hub) {
  return withHub(
    hub,
    <InstanceEditorDialog
      addonId="import-alexa"
      providerName="Alexa"
      description={{
        role: 'services',
        instanceMode: 'multiple',
        kind: 'notification-output',
        canTest: false,
        kinds: [{ id: 'alexa-echo', label: 'Alexa', functionCap: 'notification-output' }],
      }}
      instance={null}
      onClose={() => {}}
    />,
  )
}

async function tick(...values: readonly string[]): Promise<void> {
  const box = within(await screen.findByTestId('config-select-echoId')).getByRole('combobox')
  await waitFor(() => expect(box).not.toBeDisabled(), { timeout: 3000 })
  fireEvent.focus(box)
  for (const value of values) {
    fireEvent.click(await screen.findByTestId(`config-select-echoId-option-${value}`))
  }
}

function writes(hub: Hub, path: string): unknown[] {
  return hub.calls.filter((c) => c.path === path).map((c) => c.input)
}

describe('InstanceEditorDialog — create several records in one confirm', () => {
  it('two ticks: two records, each named after its candidate and holding one value', async () => {
    const hub = makeHub()
    renderCreate(hub)
    await tick('e1', 'e2')
    fireEvent.click(await screen.findByRole('button', { name: 'Create 2' }))
    await waitFor(() => expect(writes(hub, 'integrationInstances.updateInstance')).toHaveLength(2))
    const creates = writes(hub, 'integrationInstances.createInstance')
    expect(creates).toMatchObject([
      { addonId: 'import-alexa', name: 'Kitchen', kind: 'alexa-echo' },
      { addonId: 'import-alexa', name: 'Hall', kind: 'alexa-echo' },
    ])
    expect(writes(hub, 'integrationInstances.updateInstance')).toEqual([
      { addonId: 'import-alexa', id: 'rec-1', values: { echoId: 'e1' } },
      { addonId: 'import-alexa', id: 'rec-2', values: { echoId: 'e2' } },
    ])
  })

  it('a failed create stops the run and says how far it got', async () => {
    const hub = makeHub({ failCreateAt: 2 })
    renderCreate(hub)
    await tick('e1', 'e2')
    fireEvent.click(await screen.findByRole('button', { name: 'Create 2' }))
    expect(await screen.findByText(/1 of 2 created: boom/)).toBeTruthy()
    expect(writes(hub, 'integrationInstances.updateInstance')).toHaveLength(1)
  })

  it('one tick is an ordinary create: the typed name, the value as a single value', async () => {
    const hub = makeHub()
    renderCreate(hub)
    const name = (await screen.findByText(/^Name\b/)).parentElement?.querySelector('input')
    expect(name).toBeTruthy()
    fireEvent.change(name as HTMLInputElement, { target: { value: 'Bedroom speaker' } })
    await tick('e1')
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }))
    await waitFor(() => expect(writes(hub, 'integrationInstances.updateInstance')).toHaveLength(1))
    expect(writes(hub, 'integrationInstances.createInstance')).toMatchObject([
      { name: 'Bedroom speaker' },
    ])
    expect(writes(hub, 'integrationInstances.updateInstance')).toMatchObject([
      { id: 'rec-1', values: { echoId: 'e1' } },
    ])
  })
})

describe('ManyPickLabels', () => {
  it('reads the names from the discovery the field declares', async () => {
    const hub = makeHub()
    const onLabels = vi.fn()
    withHub(hub, <ManyPickLabels field={ECHO_FIELD} values={{}} onLabels={onLabels} />)
    await waitFor(() =>
      expect(onLabels).toHaveBeenLastCalledWith(
        new Map([
          ['e1', 'Kitchen'],
          ['e2', 'Hall'],
        ]),
      ),
    )
    expect(hub.calls.find((c) => c.path === 'notificationOutput.discoverTargets')?.input).toEqual({
      kind: 'alexa-echo',
      config: {},
    })
  })

  it('a failed read is said on screen and leaves every record named after its value', async () => {
    const hub = makeHub({ failDiscovery: true })
    const onLabels = vi.fn()
    withHub(hub, <ManyPickLabels field={ECHO_FIELD} values={{}} onLabels={onLabels} />)
    expect(
      (await screen.findByTestId('create-many-labels-failed', {}, { timeout: 3000 })).textContent,
    ).toContain('account offline')
    expect(onLabels).toHaveBeenLastCalledWith(new Map())
  })
})
