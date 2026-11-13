/**
 * A fake hub for specs that mount a `DeviceValuePicker` (or an editor that
 * holds one): the REAL library picker over a tRPC link that answers
 * `deviceManager.search` from a fixed fleet. The picker's queries sit behind the
 * library's own `trpc`, which a `vi.mock` of the package never reaches.
 *
 * The answer honours what the server would: `ids` resolves exactly those
 * devices, `filters.types` narrows by type, and `text` matches the name.
 */
import {
  type DeviceSearchInput,
  type DeviceSearchItem,
  type DeviceSearchResult,
  deviceOffersActions,
  DeviceType,
} from '@camstack/types'
import { trpc } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import type { TRPCLink } from '@trpc/client'
import type { AnyRouter } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import type { ReactElement, ReactNode } from 'react'

/** One device of the fake fleet; the rest of the search item is filled in. */
export interface SearchHubDevice {
  readonly id: number
  readonly name: string
  readonly type: DeviceType
  readonly location?: string | null
  /** Bound caps. Absent means the device offers no vocabulary action. */
  readonly caps?: readonly string[]
}

function itemOf(device: SearchHubDevice, compatible: boolean): DeviceSearchItem {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    location: device.location ?? null,
    integrationId: null,
    integrationLabel: null,
    online: true,
    disabled: false,
    compatible,
    values: [],
  }
}

/** The action require, judged the same way the server judges an id lookup. */
function offersActions(device: SearchHubDevice, input: DeviceSearchInput): boolean {
  const actions = input.requires?.actions ?? []
  if (actions.length === 0) return true
  return deviceOffersActions(device.caps ?? [], actions, input.requires?.mode ?? 'any', device.type)
}

function isSearchInput(input: unknown): input is DeviceSearchInput {
  return typeof input === 'object' && input !== null
}

function matches(device: SearchHubDevice, input: DeviceSearchInput): boolean {
  const types = input.filters?.types
  if (types !== undefined && types.length > 0 && !types.includes(device.type)) return false
  if (!offersActions(device, input)) return false
  const text = input.text?.trim().toLowerCase()
  return text === undefined || text === '' || device.name.toLowerCase().includes(text)
}

/** The `deviceManager.search` answer for one input over `fleet`. */
export function searchAnswer(
  fleet: readonly SearchHubDevice[],
  input: unknown,
): DeviceSearchResult {
  const query: DeviceSearchInput = isSearchInput(input) ? input : {}
  const ids = query.ids
  const picked =
    ids !== undefined
      ? fleet.filter((d) => ids.includes(d.id))
      : fleet.filter((d) => d.id !== query.contextDeviceId && matches(d, query))
  const items = picked.map((device) =>
    itemOf(device, ids === undefined ? true : offersActions(device, query)),
  )
  return {
    items,
    nextCursor: null,
    total: items.length,
    compatibleTotal: items.length,
    fleetTotal: fleet.length,
    hiddenIncompatible: 0,
    facets: { locations: [], integrations: [], types: [] },
    suggested: [],
    missingIds: ids === undefined ? [] : ids.filter((id) => !fleet.some((d) => d.id === id)),
  }
}

export interface DeviceSearchTrpcProps {
  readonly children: ReactNode
  readonly fleet: readonly SearchHubDevice[]
}

/**
 * The tRPC context for a tree that already sits in the spec's own
 * `QueryClientProvider`: every `deviceManager.search` is answered from `fleet`,
 * every other path with `null`.
 */
export function DeviceSearchTrpc({ children, fleet }: DeviceSearchTrpcProps): ReactElement {
  const queryClient = useQueryClient()
  const link: TRPCLink<AnyRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') return () => undefined
        const data = op.path === 'deviceManager.search' ? searchAnswer(fleet, op.input) : null
        observer.next({ result: { type: 'data', data } })
        observer.complete()
        return () => undefined
      })
  const client = trpc.createClient({ links: [link] })
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      {children}
    </trpc.Provider>
  )
}

/** `ui` inside a fresh query client and the fake search hub. */
export function withDeviceSearchHub(
  ui: ReactNode,
  fleet: readonly SearchHubDevice[],
): ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={queryClient}>
      <DeviceSearchTrpc fleet={fleet}>{ui}</DeviceSearchTrpc>
    </QueryClientProvider>
  )
}

/**
 * The fleet most automation specs pick from: two cameras, a light and a container,
 * so a spec can prove a camera-only or container-free picker leaves the others out.
 */
export const SEARCH_HUB_FLEET: readonly SearchHubDevice[] = [
  { id: 101, name: 'Kitchen', type: DeviceType.Camera },
  { id: 102, name: 'Garage', type: DeviceType.Camera },
  { id: 103, name: 'Porch light', type: DeviceType.Light },
  { id: 104, name: 'Hall hub', type: DeviceType.Container },
]
