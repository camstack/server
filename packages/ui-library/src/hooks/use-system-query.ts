/**
 * useSystemQuery / useSystemMutation — generic escape hatches over the
 * unified `System` SDK class for tRPC calls that don't (yet) have a
 * codegen'd named hook.
 *
 * Codegen'd hooks (see `../generated/system-hooks.ts`) cover every
 * `scope: 'system'` capability method automatically; reach for these
 * helpers when:
 *   1. The call goes through a core (non-cap) router, or
 *   2. You want to compose multiple cap calls into a single React
 *      Query bookkeeping unit (single staleTime, single retry policy).
 *
 * The query helper takes a `select(system) → () => Promise<T>` factory
 * so the caller picks any tRPC procedure off the System namespaces.
 * Inputs are passed via the closure — keeps deps explicit and avoids
 * the React Query input-as-cache-key magic that surprises new readers.
 */
import {
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'
import type { System } from '@camstack/sdk'
import { useSystem } from '../contexts/system-context.js'

/**
 * `select` MUST return a thunk that, when invoked, performs the
 * request. Two-step factory keeps the query-key + thunk identities
 * stable between renders: the hook re-creates the thunk on every
 * render (cheap), but React Query keys off `[queryKey]` only.
 */
export type SystemQuerySelector<TData> = (system: System) => () => Promise<TData>

export type SystemMutationSelector<TInput, TData> = (
  system: System,
) => (input: TInput) => Promise<TData>

export function useSystemQuery<TData>(
  queryKey: QueryKey,
  select: SystemQuerySelector<TData>,
  opts?: Omit<UseQueryOptions<TData, Error, TData>, 'queryKey' | 'queryFn'>,
): UseQueryResult<TData, Error> {
  const system = useSystem()
  return useQuery<TData, Error, TData>({
    queryKey,
    queryFn: () => select(system)(),
    ...opts,
  })
}

export function useSystemMutation<TInput, TData>(
  select: SystemMutationSelector<TInput, TData>,
  opts?: Omit<UseMutationOptions<TData, Error, TInput>, 'mutationFn'>,
): UseMutationResult<TData, Error, TInput> {
  const system = useSystem()
  return useMutation<TData, Error, TInput>({
    mutationFn: (input: TInput) => select(system)(input),
    ...opts,
  })
}
