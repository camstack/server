/**
 * A fake hub for specs that mount a `DeviceTemplateField` (or an editor that
 * holds one): the REAL generated hooks over a link that answers from a table,
 * so the field's own `deviceManager.*` reads reach an answer. The library's
 * hooks sit behind its own bundle, which a `vi.mock` of the package never reaches.
 */
import { System } from '@camstack/sdk'
import { SystemProvider, trpc } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import type { TRPCLink } from '@trpc/client'
import type { AnyRouter } from '@trpc/server'
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

export interface TemplateHubTrpcProps {
  readonly children: ReactNode
  readonly answers?: TemplateHubAnswers
  /** False when the spec already provides its own `SystemProvider`. */
  readonly withSystem?: boolean
}

/**
 * The tRPC context and a `System` for a tree that already sits in the spec's
 * own `QueryClientProvider`: wrap the page of a spec that mounts an editor
 * holding a `DeviceTemplateField`.
 */
export function TemplateHubTrpc({
  children,
  answers = {},
  withSystem = true,
}: TemplateHubTrpcProps): ReactElement {
  const queryClient = useQueryClient()
  const link: TRPCLink<AnyRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') return () => undefined
        observer.next({ result: { type: 'data', data: answerFor(op.path, answers) } })
        observer.complete()
        return () => undefined
      })
  const client = trpc.createClient({ links: [link] })
  // A real `System`, never connected: the field's reads ride `trpc.Provider`;
  // `useSystem()` callers only need an instance to read.
  const system = new System({ serverUrl: 'http://hub.invalid', useWebSocket: false })
  const tree = (
    <trpc.Provider client={client} queryClient={queryClient}>
      {children}
    </trpc.Provider>
  )
  return withSystem ? <SystemProvider system={system}>{tree}</SystemProvider> : tree
}

export function renderWithTemplateHub(
  ui: ReactNode,
  answers: TemplateHubAnswers = {},
): ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={queryClient}>
      <TemplateHubTrpc answers={answers}>{ui}</TemplateHubTrpc>
    </QueryClientProvider>
  )
}
