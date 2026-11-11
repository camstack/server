import { type ReactElement, type ReactNode, useState } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import { ButtonGroup } from '../parts/ButtonGroup'
import { CardButton } from '../parts/CardButton'
import { EventList } from '../parts/EventList'
import type { CardHistory, CardRemoteKey, CardState } from './model'
import { cardToneClass } from './Corner'

interface BarProps {
  readonly onBack: () => void
  readonly children: ReactNode
}

function OverlayBar({ onBack, children }: BarProps): ReactElement {
  const t = useUiText()
  return (
    <div className="flex items-center gap-2">
      <CardButton
        glyph="back"
        actuates={false}
        aria-label={t('uiLibrary.deviceCard.back', 'Back to the current state')}
        onClick={onBack}
        data-testid="dc-back"
        className="min-h-8 min-w-8 px-2 py-1"
      />
      <span className="text-xs font-semibold uppercase tracking-wide">{children}</span>
    </div>
  )
}

export interface HistoryViewProps {
  readonly state: CardState
  readonly history: CardHistory
  readonly onBack: () => void
}

/** Replaces the scene: the device's charts and who did what. */
export function HistoryView({ state, history, onBack }: HistoryViewProps): ReactElement {
  const t = useUiText()
  const tabs = [
    ...(history.charts === null
      ? []
      : [
          {
            id: 'charts',
            label: t('uiLibrary.deviceCard.history.charts', 'History'),
          },
        ]),
    ...(history.events === null
      ? []
      : [
          {
            id: 'events',
            label: t('uiLibrary.deviceCard.history.events', 'Interactions'),
          },
        ]),
  ]
  const [tab, setTab] = useState(tabs[0]?.id ?? 'charts')
  return (
    <div
      data-testid="dc-history"
      className="flex flex-col gap-3 rounded-2xl border border-border bg-background-elevated p-3"
    >
      <OverlayBar onBack={onBack}>
        <span className={cardToneClass(state.tone)}>{state.label}</span>
        {state.since === null ? null : (
          <small className="ml-1 font-normal normal-case text-foreground-muted">
            · {state.since}
          </small>
        )}
      </OverlayBar>
      {tabs.length > 1 ? (
        <ButtonGroup
          options={tabs}
          value={tab}
          onChange={setTab}
          actuates={false}
          ariaLabel={t('uiLibrary.deviceCard.history.charts', 'History')}
        />
      ) : null}
      {tab === 'charts' ? history.charts : null}
      {tab === 'events' && history.events !== null ? (
        <EventList
          events={history.events}
          emptyLabel={t('uiLibrary.deviceCard.history.noEvents', 'No interactions yet')}
        />
      ) : null}
    </div>
  )
}

export interface RemoteViewProps {
  readonly keys: readonly CardRemoteKey[]
  readonly onKey: (id: string) => void
  readonly onBack: () => void
}

/** Replaces the scene: the keys the device's remote declares. */
export function RemoteView({ keys, onKey, onBack }: RemoteViewProps): ReactElement {
  const t = useUiText()
  const [flashed, setFlashed] = useState<string | null>(null)
  return (
    <div
      data-testid="dc-remote-view"
      className="flex flex-col gap-3 rounded-2xl border border-border bg-background-elevated p-3"
    >
      <OverlayBar onBack={onBack}>{t('uiLibrary.deviceCard.remote', 'Remote')}</OverlayBar>
      <div className="flex flex-wrap justify-center gap-2">
        {keys.map((k) => (
          <CardButton
            key={k.id}
            glyph={k.glyph}
            tone={flashed === k.id ? 'on' : 'default'}
            className={flashed === k.id ? 'dc-flash' : undefined}
            onClick={() => {
              setFlashed(k.id)
              onKey(k.id)
            }}
            onAnimationEnd={() => setFlashed(null)}
          >
            {k.label}
          </CardButton>
        ))}
      </div>
      <p className="text-center text-xs text-foreground-muted">
        {t('uiLibrary.deviceCard.remoteNote', 'The keys are the ones the device declares.')}
      </p>
    </div>
  )
}
