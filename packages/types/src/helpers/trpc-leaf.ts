import type { AddonApi } from '../generated/addon-api.js'

/** tRPC client procedure bundle (`query` / `mutate` / `subscribe`). */
export interface TrpcProcedureLeaf {
  readonly query?: (input?: unknown) => unknown
  readonly mutate?: (input?: unknown) => unknown
  readonly subscribe?: (input?: unknown, push?: unknown) => unknown
}

function isCapRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || Array.isArray(value)) return false
  const kind = typeof value
  return kind === 'object' || kind === 'function'
}

export function isTrpcProcedureLeaf(value: unknown): value is TrpcProcedureLeaf {
  if (!isCapRecord(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.query === 'function' ||
    typeof record.mutate === 'function' ||
    typeof record.subscribe === 'function'
  )
}

function readCapRecord(api: AddonApi, capProp: string): Record<string, unknown> | undefined {
  const cap = Reflect.get(api, capProp)
  if (!isCapRecord(cap)) return undefined
  return cap as Record<string, unknown>
}

export function readTrpcLeaf(api: AddonApi, capProp: string, method: string): TrpcProcedureLeaf {
  const capRecord = readCapRecord(api, capProp)
  if (!capRecord) {
    throw new Error(`tRPC client has no router '${capProp}'`)
  }
  const leaf = capRecord[method]
  if (!isTrpcProcedureLeaf(leaf)) {
    throw new Error(`tRPC client has no '${capProp}.${method}'`)
  }
  return leaf
}

export type TrpcDispatchKind = 'query' | 'mutation' | 'subscription'

/**
 * Invoke `api.<capProp>.<method>.{query|mutate|subscribe}(input)`.
 * `Result` is the generated proxy method's return. The leaf itself is only
 * `unknown` (the client is a structural bag), so the assertion is the one
 * boundary between that bag and the typed proxy.
 */
export function invokeTrpcLeaf<Result>(
  api: AddonApi,
  capProp: string,
  method: string,
  kind: TrpcDispatchKind,
  input?: unknown,
  push?: unknown,
): Result {
  const fn = readTrpcLeaf(api, capProp, method)
  if (kind === 'mutation') {
    if (typeof fn.mutate !== 'function') {
      throw new Error(`tRPC '${capProp}.${method}' has no mutate()`)
    }
    return fn.mutate(input) as Result
  }
  if (kind === 'subscription') {
    if (typeof fn.subscribe !== 'function') {
      throw new Error(`tRPC '${capProp}.${method}' has no subscribe()`)
    }
    return fn.subscribe(input, push) as Result
  }
  if (typeof fn.query !== 'function') {
    throw new Error(`tRPC '${capProp}.${method}' has no query()`)
  }
  return fn.query(input) as Result
}
