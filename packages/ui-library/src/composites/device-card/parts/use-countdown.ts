import { useEffect, useState } from 'react'

const TICK_MS = 1_000

/** Milliseconds left until `endsAt`, re-read every second; null when nothing runs. */
export function useCountdown(endsAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (endsAt === null) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [endsAt])
  return endsAt === null ? null : Math.max(0, endsAt - now)
}
