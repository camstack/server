import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { callCcuAction, type CcuTrpc } from './ccu-client.js'

export interface CcuData<T> {
  /** `undefined` until the first answer: not-yet-known is not "empty". */
  readonly data: T | undefined
  readonly error: string | null
  readonly loading: boolean
  readonly reload: () => void
}

/**
 * One read-only custom action as page state. `input === null` means "not ready
 * to ask" (no CCU picked yet): nothing is fetched. An answer that arrives after
 * the input changed is dropped.
 */
export function useCcuData<S extends z.ZodType>(
  trpc: CcuTrpc,
  action: string,
  input: unknown,
  schema: S,
  options: { readonly pollMs?: number } = {},
): CcuData<z.infer<S>> {
  const [data, setData] = useState<z.infer<S> | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(input !== null)
  const [nonce, setNonce] = useState(0)
  const latest = useRef(0)
  const inputKey = JSON.stringify(input)
  const pollMs = options.pollMs

  useEffect(() => {
    if (input === null) {
      setData(undefined)
      setLoading(false)
      return
    }
    const ticket = ++latest.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = (first: boolean): void => {
      if (first) setLoading(true)
      callCcuAction(trpc, action, input, schema).then(
        (answer) => {
          if (latest.current !== ticket) return
          setData(answer)
          setError(null)
          setLoading(false)
          if (pollMs !== undefined) timer = setTimeout(() => run(false), pollMs)
        },
        (err: unknown) => {
          if (latest.current !== ticket) return
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
          if (pollMs !== undefined) timer = setTimeout(() => run(false), pollMs)
        },
      )
    }
    run(true)
    return () => {
      latest.current++
      if (timer !== undefined) clearTimeout(timer)
    }
    // `input` is tracked through its serialised key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trpc, action, inputKey, schema, nonce, pollMs])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, reload }
}
