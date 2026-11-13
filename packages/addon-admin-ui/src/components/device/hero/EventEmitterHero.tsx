import { findVocabularyEntry, readEventVocabulary } from '@camstack/types'
import { useDeviceProxy, useDeviceStateSlice, useSystem } from '@camstack/ui-library'
import { Hand, MousePointerClick } from 'lucide-react'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import {
  describeFire,
  formatEventAge,
  groupVocabulary,
  sharedVocabularyNotice,
} from './event-emitter-format'
import type { HeroProps } from './HeroRegistry'
import { useTranslation } from 'react-i18next'

/**
 * Event-emitter hero — the observational readout for a PURE INPUT device
 * (wall switch, remote, scene controller). There is nothing to actuate: the
 * hero exists to answer "did it fire, which button, how long ago".
 *
 * It reads the `event-emitter` cap's runtime-state slice, so it is
 * cap-derived and works for ANY provider that registers the cap. What the
 * device can fire is its declared vocabulary (D1044): one row per part of the
 * device (a button) with the events of that part, in the device's own labels.
 * A slice written before the vocabulary existed shows its plain tokens. No
 * provider is named anywhere in this file.
 *
 * Two reads, per D8 (events are telemetry and may be dropped):
 *   - the push subscription, which is what makes a live press flash; and
 *   - an explicit `refresh()` on mount plus a slow reconcile, because the
 *     slice handle's cache starts EMPTY and a press may be hours old. Without
 *     the seed the hero would claim "no press recorded" on a device that has
 *     fired all day. `device.state-changed` reaches forked children through
 *     `ctx.eventBus` (not `live.onEvent`); this reconcile is still the D8
 *     backstop for a dropped event.
 */

/** How long the highlight stays lit after a new press. */
const FLASH_MS = 1_500
/** Re-read the slice this often — the D8 reconcile behind the push. */
const RECONCILE_MS = 15_000
/** Re-render this often so the "3s ago" line advances on its own. */
const AGE_TICK_MS = 1_000

export function EventEmitterHero({ deviceId }: HeroProps): ReactElement {
  const { t } = useTranslation()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const handle = dev?.state.eventEmitter
  const slice = useDeviceStateSlice(handle)

  // Seed + reconcile. `handle` identity is stable per proxy, so this runs once
  // per binding resolution rather than per render.
  useEffect(() => {
    if (!handle) return
    void handle.refresh()
    const id = setInterval(() => {
      void handle.refresh()
    }, RECONCILE_MS)
    return () => {
      clearInterval(id)
    }
  }, [handle])

  const lastEvent = slice?.lastEvent ?? null
  const seq = lastEvent?.seq ?? null

  // Flash on a NEW press. `seq` is monotonic per the cap, so two identical
  // presses still differ here — a timestamp or an event-type comparison would
  // silently miss the second one.
  const seenSeq = useRef<number | null>(null)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (seq === null) return
    const previous = seenSeq.current
    seenSeq.current = seq
    if (previous === null || previous === seq) return
    setFlashing(true)
    const timer = setTimeout(() => {
      setFlashing(false)
    }, FLASH_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [seq])

  // Own clock tick — the age line is derived from a fixed timestamp, so
  // nothing else would ever re-render it.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, AGE_TICK_MS)
    return () => {
      clearInterval(id)
    }
  }, [])

  const vocabulary = slice === undefined ? [] : readEventVocabulary(slice)
  const groups = groupVocabulary(vocabulary)
  const notice = sharedVocabularyNotice(vocabulary)
  const described = describeFire(lastEvent, vocabulary)
  const headline =
    described === null
      ? null
      : described.source === null
        ? described.label
        : `${described.source} · ${described.label}`
  const lastEntry =
    lastEvent === null
      ? undefined
      : findVocabularyEntry(vocabulary, lastEvent.eventType, lastEvent.sourceId)
  const count = slice?.eventCountSinceStart ?? 0
  const hasState = slice !== undefined

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4">
      <div
        data-testid="event-emitter-indicator"
        data-flashing={String(flashing)}
        className={`flex h-24 w-24 items-center justify-center rounded-full border-2 transition-all ${
          flashing
            ? 'border-primary bg-primary/20 text-primary shadow-lg shadow-primary/30 scale-105'
            : 'border-border bg-surface text-foreground-subtle'
        }`}
        aria-live="polite"
        title={headline ?? t('hero.eventEmitterHero.noPressRecorded', 'No press recorded')}
      >
        {flashing ? <MousePointerClick className="h-10 w-10" /> : <Hand className="h-10 w-10" />}
      </div>

      <div className="text-center">
        {described !== null && described.source !== null && (
          <div
            data-testid="event-emitter-source"
            className="text-xs font-semibold uppercase tracking-wide text-primary"
          >
            {described.source}
          </div>
        )}
        <div
          data-testid="event-emitter-headline"
          className={`text-sm font-semibold ${headline ? 'text-foreground' : 'text-foreground-subtle'}`}
        >
          {headline ??
            (hasState
              ? t('hero.eventEmitterHero.noPressRecorded', 'No press recorded')
              : t('hero.eventEmitterHero.awaitingState', 'Awaiting state…'))}
        </div>
        <div className="text-[10px] text-foreground-subtle mt-0.5">
          {lastEvent
            ? formatEventAge(lastEvent.timestamp, now)
            : t('hero.eventEmitterHero.waitingForTheFirstEvent', 'Waiting for the first event')}
        </div>
      </div>

      {notice !== null && (
        <p
          data-testid="event-emitter-notice"
          className="max-w-full text-center text-xs text-foreground-subtle"
        >
          {notice}
        </p>
      )}

      {groups.length > 0 && (
        <div className="flex max-w-full flex-col items-center gap-1">
          {groups.map((group) => (
            <div
              key={group.source?.id ?? ''}
              data-testid="event-emitter-source-row"
              className="flex max-w-full flex-wrap items-center justify-center gap-1"
            >
              {group.source !== null && (
                <span className="text-[10px] font-semibold text-foreground-subtle">
                  {group.source.label}
                </span>
              )}
              {group.entries.map((entry) => (
                <span
                  key={`${group.source?.id ?? ''}:${entry.id}`}
                  data-testid="event-emitter-chip"
                  title={entry.description ?? entry.id}
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    entry === lastEntry
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-border bg-surface text-foreground-subtle'
                  }`}
                >
                  {entry.label}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] text-foreground-subtle">
        {t('hero.eventEmitterHero.sinceStart', { count })}
      </div>
    </div>
  )
}
