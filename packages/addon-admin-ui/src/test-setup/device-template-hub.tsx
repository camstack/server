/**
 * A fake hub for specs that mount a `DeviceTemplateField` (or an editor that
 * holds one): the REAL generated hooks over a link that answers from a table,
 * so the field's own `deviceManager.*` reads reach an answer. The library's
 * hooks sit behind its own bundle, which a `vi.mock` of the package never reaches.
 */
import type { System } from '@camstack/sdk'
import { SystemProvider, trpc } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { ReactElement, ReactNode } from 'react'

export const STUFA = {
  id: 1,
  name: 'Stufa veranda',
  alias: 'stufa',
  stableId: 'stufa-1',
  addonId: 'test',
  type: 'sensor',
  location: null,
  parentDeviceId: null,
  disabled: false,
}

export interface TemplateHubAnswers {
  /** The `checkDeviceTemplates` result for one template; default: vetted, no aliases. */
  readonly check?: unknown
}

function answerFor(path: string, answers: TemplateHubAnswers): unknown {
  switch (path) {
    case 'deviceManager.listAll':
      return [STUFA]
    case 'deviceManager.checkDeviceTemplates':
      return { results: [answers.check ?? { ok: true, aliases: [] }] }
    case 'deviceManager.renderDeviceTemplates':
      return { results: [{ ok: true, text: '', trace: [] }] }
    case 'deviceManager.listSiteZones':
      return []
    case 'deviceManager.getWireableFields':
      return { caps: [] }
    default:
      return null
  }
}

export function renderWithTemplateHub(
  ui: ReactNode,
  answers: TemplateHubAnswers = {},
): ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const link: TRPCLink<never> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') return () => undefined
        observer.next({ result: { type: 'data', data: answerFor(op.path, answers) } } as never)
        observer.complete()
        return () => undefined
      })
  const client = trpc.createClient({ links: [link] })
  const system = {
    trpcClient: createTRPCClient({ links: [link] }),
    subscribeConnectionEvents: () => () => undefined,
    onEvent: () => () => undefined,
    subscribeEvents: () => () => undefined,
    subscribeEvent: () => () => undefined,
    subscribe: () => () => undefined,
  } as unknown as System
  return (
    <QueryClientProvider client={queryClient}>
      <trpc.Provider client={client} queryClient={queryClient}>
        <SystemProvider system={system}>{ui}</SystemProvider>
      </trpc.Provider>
    </QueryClientProvider>
  )
}
