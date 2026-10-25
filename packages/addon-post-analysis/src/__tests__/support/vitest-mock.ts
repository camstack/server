/** Narrows after an explicit null/undefined check — for specs that throw on absent values. */
export function defined<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be present`)
  }
  return value
}

/** First call tuple from a vitest mock — fails loud when never invoked. */
/** Resolver assigned inside `new Promise` — TS does not narrow `| null` at the call site. */
export function callDeferredRelease<T extends readonly unknown[]>(
  release: ((...args: T) => void) | null,
  ...args: T
): void {
  if (release === null) {
    throw new Error('expected deferred release to be assigned')
  }
  release(...args)
}

export function mockFirstCall<Args extends readonly unknown[]>(mockFn: {
  readonly mock: { readonly calls: readonly Args[] }
}): Args {
  const first = mockFn.mock.calls[0]
  if (first === undefined) {
    throw new Error('expected mock to have been called at least once')
  }
  return first
}

/** Every `columns` argument from settings-store `query` spy calls. */
export function mockQueryColumnProjections(spy: {
  readonly mock: { readonly calls: readonly unknown[][] }
}): Array<readonly string[] | undefined> {
  return spy.mock.calls.map((call) => {
    const first = call[0]
    if (first === null || typeof first !== 'object') return undefined
    if (!('columns' in first)) return undefined
    const columns = first.columns
    if (columns === undefined) return undefined
    return columns as readonly string[]
  })
}
