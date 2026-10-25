/**
 * DeviceActivityPanel — unified Logs / Events / State Values viewer.
 *
 * Three internal tabs:
 *  - Logs        → LogStream (scoped to deviceId)
 *  - Events      → EventStream (multiselect of EventCategory + free text)
 *  - State Values → StateValuesStream (DeviceStateChanged subscription)
 *
 * Only the active tab is rendered. tRPC subscriptions in the inactive
 * tabs are torn down because the components are unmounted — keeps the
 * websocket lean even when many devices have a panel open.
 *
 * The panel hosts three live buffers (`logs` / `events` / `state`) and
 * passes them to the streams. Subscriptions still only fire while
 * their stream is mounted, but the entries already received persist
 * across tab switches — so reopening the State tab doesn't reset
 * the visible list to empty just because the global event ring
 * buffer evicted the older state-changed entries.
 */
import { useEffect, useState, type JSX } from 'react'
import { ScrollText, Bell, Database, type LucideIcon } from 'lucide-react'
import { LogStream } from './log-stream'
import { EventStream } from './event-stream'
import { StateValuesStream } from './state-values-stream'
import { useLiveBuffer } from '../hooks/use-live-buffer'
import { cn } from '../lib/cn'
import { useUiText } from '../contexts/ui-text'

// Buffer size mirror — keep in sync with the per-stream MAX_LIVE_ENTRIES
// constants. They've all converged on a few hundred entries; 500 covers
// the most-verbose Logs path without bloating the panel.
const PANEL_BUFFER_SIZE = 500

export interface DeviceActivityPanelProps {
  readonly deviceId: number
  /** When this device is a Container, its own id — the Logs tab then shows the
   *  whole subtree (container + every child) by filtering `containerDeviceId`
   *  instead of `deviceId`. Omit/undefined for a non-container. */
  readonly containerDeviceId?: number
  /** Initial event categories the user wants tracked. Defaults to "all". */
  readonly defaultEventCategories?: readonly string[]
  /** Initial state-cap whitelist. Empty = show every cap that fires. */
  readonly defaultStateCaps?: readonly string[]
  /** Tab to show first. */
  readonly initialTab?: ActivityTabId
  /** CSS class for the panel root. */
  readonly className?: string
  /** Max content height (passed to the active stream). */
  readonly maxHeight?: string
}

export type ActivityTabId = 'logs' | 'events' | 'state'

interface ActivityTab {
  readonly id: ActivityTabId
  readonly labelKey: string
  readonly labelFallback: string
  readonly icon: LucideIcon
}

const TABS: readonly ActivityTab[] = [
  {
    id: 'logs',
    labelKey: 'uiLibrary.deviceActivityPanel.logs',
    labelFallback: 'Logs',
    icon: ScrollText,
  },
  {
    id: 'events',
    labelKey: 'uiLibrary.deviceActivityPanel.events',
    labelFallback: 'Events',
    icon: Bell,
  },
  {
    id: 'state',
    labelKey: 'uiLibrary.deviceActivityPanel.state',
    labelFallback: 'State',
    icon: Database,
  },
]

export function DeviceActivityPanel({
  deviceId,
  containerDeviceId,
  defaultEventCategories,
  defaultStateCaps,
  initialTab = 'events',
  className,
  maxHeight = 'max-h-96',
}: DeviceActivityPanelProps): JSX.Element {
  const t = useUiText()
  const [tab, setTab] = useState<ActivityTabId>(initialTab)

  // Three buffers that survive tab switches. Each stream component
  // appends to its respective buffer when its subscription pushes a
  // new entry; switching to another tab unmounts the stream (closing
  // the subscription) but the entries already collected stay in
  // memory and are shown again the next time the tab is opened.
  const logsBuffer =
    useLiveBuffer<
      Parameters<typeof LogStream>[0]['liveBuffer'] extends infer B
        ? B extends { entries: readonly (infer E)[] }
          ? E
          : never
        : never
    >(PANEL_BUFFER_SIZE)
  const eventsBuffer =
    useLiveBuffer<
      Parameters<typeof EventStream>[0]['liveBuffer'] extends infer B
        ? B extends { entries: readonly (infer E)[] }
          ? E
          : never
        : never
    >(PANEL_BUFFER_SIZE)
  const stateBuffer =
    useLiveBuffer<
      Parameters<typeof StateValuesStream>[0]['liveBuffer'] extends infer B
        ? B extends { entries: readonly (infer E)[] }
          ? E
          : never
        : never
    >(PANEL_BUFFER_SIZE)

  // Reset every buffer when the panel switches to a different device —
  // a stale buffer from device #5 must not bleed into the panel for
  // device #6.
  // Reset every buffer when the panel switches device. The reset
  // closures themselves are stable (memoized inside `useLiveBuffer`
  // via `useCallback`), so recapturing them per render is fine — the
  // effect fires only when `deviceId` actually changes thanks to the
  // closure equality React-Query relies on.
  const logsReset = logsBuffer.reset
  const eventsReset = eventsBuffer.reset
  const stateReset = stateBuffer.reset
  useEffect(() => {
    logsReset()
    eventsReset()
    stateReset()
  }, [deviceId, logsReset, eventsReset, stateReset])

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      {/* Tab strip */}
      <div className="flex items-center gap-1 mb-2 shrink-0">
        {TABS.map(({ id, labelKey, labelFallback, icon: Icon }) => {
          const active = tab === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors',
                active
                  ? 'bg-primary/15 text-primary border border-primary/30'
                  : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover border border-transparent',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(labelKey, labelFallback)}
            </button>
          )
        })}
      </div>

      {/* Active tab content. Only ONE stream is mounted at a time so
          the tRPC subscriptions of the others are released, but each
          stream operates on a parent-owned buffer so the list survives
          tab switches. */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'logs' && (
          <LogStream
            {...(containerDeviceId !== undefined ? { containerDeviceId } : { deviceId })}
            maxHeight={maxHeight}
            showFilters={false}
            liveBuffer={logsBuffer}
          />
        )}
        {tab === 'events' && (
          <EventStream
            deviceId={deviceId}
            defaultCategories={defaultEventCategories}
            maxHeight={maxHeight}
            showCategoryFilter
            liveBuffer={eventsBuffer}
          />
        )}
        {tab === 'state' && (
          <StateValuesStream
            deviceId={deviceId}
            defaultCaps={defaultStateCaps}
            maxHeight={maxHeight}
            liveBuffer={stateBuffer}
          />
        )}
      </div>
    </div>
  )
}
