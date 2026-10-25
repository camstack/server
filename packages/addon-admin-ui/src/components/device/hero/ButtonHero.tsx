import { useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import { useDeviceProxy, useDeviceStateSlice, useSystem } from '@camstack/ui-library'
import { formatRelativeTime, isSameLocalDay } from './format'
import type { HeroProps } from './HeroRegistry'
import { useTranslation } from 'react-i18next'

/**
 * Button (doorbell) hero — "last press" timestamp + "today" counter.
 *
 * The `doorbell` cap exposes `pressCountSinceStart` (lifetime since
 * provider start), but operators want "presses today" — so we maintain
 * a tiny client-side `todayCount` from the slice's `lastPressedAt`
 * transitions. A `lastPressedAt` change that lands on the same local
 * day increments the counter; a press from a previous day re-baselines
 * it. No persistence — refresh resets, which matches the unbounded
 * lifetime counter's freshness.
 */
export function ButtonHero({ deviceId }: HeroProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const slice = useDeviceStateSlice(dev?.state.doorbell)

  const lastPressedAt = slice?.lastPressedAt ?? null
  const hasState = slice !== undefined
  const isFreshPress = lastPressedAt !== null && Date.now() - lastPressedAt < 60_000

  // Local "today" counter — incremented on each new lastPressedAt that
  // matches today's date. Skips identical timestamps (slice replays on
  // re-mount fire the same value once with no real press).
  const [todayCount, setTodayCount] = useState(0)
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null)
  useEffect(() => {
    if (lastPressedAt === null || lastPressedAt === lastSeenAt) return
    setLastSeenAt(lastPressedAt)
    if (isSameLocalDay(lastPressedAt)) {
      setTodayCount((n) => n + 1)
    }
  }, [lastPressedAt, lastSeenAt])

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4">
      <div
        className={`flex h-24 w-24 items-center justify-center rounded-full border-2 transition-all ${
          isFreshPress
            ? 'border-primary bg-primary/20 text-primary shadow-lg shadow-primary/30 animate-pulse'
            : 'border-border bg-surface text-foreground-subtle'
        }`}
        aria-live="polite"
        title={
          isFreshPress
            ? t('hero.buttonHero.justPressed', 'Just pressed')
            : t('hero.buttonHero.idle', 'Idle')
        }
      >
        <Bell className="h-10 w-10" />
      </div>
      <div className="text-center">
        <div
          className={`text-sm font-semibold ${isFreshPress ? 'text-primary' : 'text-foreground-subtle'}`}
        >
          {hasState
            ? t('hero.buttonHero.lastPress', 'Last press {{value1}}', {
                value1: formatRelativeTime(lastPressedAt),
              })
            : t('hero.buttonHero.unknown', 'Unknown')}
        </div>
        <div className="text-[10px] text-foreground-subtle mt-0.5 tabular-nums">
          {hasState
            ? t('hero.buttonHero.ringsToday', { count: todayCount })
            : t('hero.buttonHero.awaitingState', 'Awaiting state…')}
        </div>
      </div>
    </div>
  )
}
