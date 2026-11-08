import { useDeviceProxy, useSystem } from '@camstack/ui-library'
import { useEffect } from 'react'

const COALESCE_MS = 250

interface Subscribable {
  readonly subscribe: (listener: () => void) => () => void
}

function isSubscribable(value: unknown): value is Subscribable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'subscribe' in value &&
    typeof value.subscribe === 'function'
  )
}

/**
 * Re-reads the hero model when any state slice of the device pushes: the same
 * live mechanism the legacy hero reads its slices through (`useDeviceProxy`),
 * instead of polling. Bursts of pushes collapse into one refetch.
 */
export function useHeroLiveRefresh(deviceId: number, refetch: () => unknown): void {
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  useEffect(() => {
    if (dev === null) return undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (): void => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        void refetch()
      }, COALESCE_MS)
    }
    const stops = Object.values(dev.state)
      .filter(isSubscribable)
      .map((slice) => slice.subscribe(schedule))
    return () => {
      if (timer !== null) clearTimeout(timer)
      for (const stop of stops) stop()
    }
  }, [dev, refetch])
}
