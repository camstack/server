/**
 * useEventStreamLatest — subscribe to a `live.onEvent` category and
 * keep the LATEST payload in React state. Zero polling — pure push.
 *
 * useEventStreamMap — same but accumulates per-key payloads into a map.
 */
import { useMemo, useRef, useState } from 'react'
import { useLiveEvent } from './use-live-event'

function useFreshRef<T>(value: T): { readonly current: T } {
  const ref = useRef<T>(value)
  ref.current = value
  return ref
}

export function useEventStreamLatest<T>(category: string, filter?: (data: T) => boolean): T | null {
  const [data, setData] = useState<T | null>(null)
  const filterRef = useFreshRef(filter)
  useLiveEvent<T>(category, (evt) => {
    const payload = evt.data
    const f = filterRef.current
    if (f && !f(payload)) return
    setData(payload)
  })
  return data
}

export function useEventStreamMap<T, K extends string | number>(
  category: string,
  keyOf: (data: T) => K,
  filter?: (data: T) => boolean,
): { readonly map: ReadonlyMap<K, T>; readonly values: readonly T[] } {
  const [map, setMap] = useState<ReadonlyMap<K, T>>(() => new Map())
  const keyOfRef = useFreshRef(keyOf)
  const filterRef = useFreshRef(filter)
  useLiveEvent<T>(category, (evt) => {
    const payload = evt.data
    const f = filterRef.current
    if (f && !f(payload)) return
    const k = keyOfRef.current(payload)
    setMap((prev) => {
      const next = new Map(prev)
      next.set(k, payload)
      return next
    })
  })
  const values = useMemo(() => Array.from(map.values()), [map])
  return { map, values }
}
