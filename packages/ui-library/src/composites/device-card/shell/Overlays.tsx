import { type ReactElement, type ReactNode, useState } from 'react'
import { cn } from '../../../lib/cn'
import { useUiText, type UiTextFn } from '../../../contexts/ui-text'
import { useCapabilityPresence } from '../../../hooks/use-capability-presence'
import { ViewSwitch, type ViewSwitchOption } from '../../view-switch'
import { CardButton } from '../parts/CardButton'
import { EventList } from '../parts/EventList'
import { RemoteGrid, SourceSelectKey } from '../../remote'
import { ActuationHistory } from './ActuationHistory'
import { historyPanes, shownHistoryPane, type HistoryPane } from './history-sections'
import type { CardHistory, CardRemoteKey, CardRemotePanel, CardState } from './model'
import { cardToneClass } from './Corner'
import { remoteKeyIconOnly, remotePadRows } from './remote-keys'

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
  /** Present on a live device: the actuations section asks for this device. */
  readonly deviceId?: number
}

function paneOptions(
  panes: readonly HistoryPane[],
  t: UiTextFn,
): readonly ViewSwitchOption<HistoryPane>[] {
  return panes.map((id) => ({
    id,
    label:
      id === 'values'
        ? t('uiLibrary.deviceCard.history.charts', 'History')
        : t('uiLibrary.deviceCard.history.events', 'Interactions'),
  }))
}

interface HistoryPanesProps extends HistoryViewProps {
  /** False hides the switch and the actuation list: values only. */
  readonly actuationsOffered: boolean
}

function HistoryPanes({
  state,
  history,
  onBack,
  deviceId,
  actuationsOffered,
}: HistoryPanesProps): ReactElement {
  const t = useUiText()
  const panes = historyPanes({
    hasValues: history.charts !== null,
    hasEvents: history.events !== null,
    actuationsOffered,
  })
  const [chosen, setChosen] = useState<HistoryPane>('values')
  const pane = shownHistoryPane(panes, chosen)
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
      <ViewSwitch
        options={paneOptions(panes, t)}
        value={pane}
        onChange={setChosen}
        ariaLabel={t('uiLibrary.deviceCard.history.sectionSwitch', 'History sections')}
        testId="dc-history-sections"
      />
      {pane === 'values' ? history.charts : null}
      {pane === 'interactions' && !actuationsOffered && history.events !== null ? (
        <EventList
          events={history.events}
          emptyLabel={t('uiLibrary.deviceCard.history.noEvents', 'No interactions yet')}
        />
      ) : null}
      {pane === 'interactions' && actuationsOffered && deviceId !== undefined ? (
        <ActuationHistory deviceId={deviceId} />
      ) : null}
    </div>
  )
}

interface HistoryWithCapabilityProps extends HistoryViewProps {
  readonly deviceId: number
}

/** Asks whether this cluster records actuations before offering the section. */
function HistoryWithCapability({ deviceId, ...rest }: HistoryWithCapabilityProps): ReactElement {
  const presence = useCapabilityPresence('device-transitions')
  return <HistoryPanes {...rest} deviceId={deviceId} actuationsOffered={presence !== 'absent'} />
}

/** Replaces the scene: the device's values, or who changed them. */
export function HistoryView(props: HistoryViewProps): ReactElement {
  if (props.deviceId === undefined) return <HistoryPanes {...props} actuationsOffered={false} />
  return <HistoryWithCapability {...props} deviceId={props.deviceId} />
}

export interface RemoteViewProps {
  readonly keys: readonly CardRemoteKey[]
  /** The layout grid. Null: the declared keys, as a pad when they have one. */
  readonly panel?: CardRemotePanel | null
  /** A saved layout has not arrived yet: draw the frame, never the raw keys. */
  readonly layoutPending?: boolean
  readonly onKey: (id: string) => void
  readonly onBack: () => void
  /** Drawn under the keys: what the scene does not (shuffle, repeat). */
  readonly extra?: ReactNode
}

interface RemoteKeyButtonProps {
  readonly k: CardRemoteKey
  readonly flashed: boolean
  readonly onPress: (id: string) => void
  readonly onFlashEnd: () => void
  readonly pos?: string
}

function RemoteKeyButton({
  k,
  flashed,
  onPress,
  onFlashEnd,
  pos,
}: RemoteKeyButtonProps): ReactElement {
  const iconOnly = remoteKeyIconOnly(k)
  return (
    <CardButton
      glyph={k.glyph}
      tone={flashed ? 'on' : 'default'}
      className={cn(flashed && 'dc-flash', pos !== undefined && 'min-h-0')}
      data-pos={pos}
      data-testid={`dc-remote-key-${k.id}`}
      {...(iconOnly ? { 'aria-label': k.label, title: k.label } : {})}
      onClick={() => onPress(k.id)}
      onAnimationEnd={onFlashEnd}
    >
      {iconOnly ? null : k.label}
    </CardButton>
  )
}

/** Replaces the scene: the saved layout, or the keys the device declares. */
export function RemoteView({
  keys,
  panel = null,
  layoutPending = false,
  onKey,
  onBack,
  extra = null,
}: RemoteViewProps): ReactElement {
  const t = useUiText()
  const [flashed, setFlashed] = useState<string | null>(null)
  const rows = remotePadRows(keys)
  const title = t('uiLibrary.deviceCard.remote', 'Remote')
  if (panel !== null) {
    const bound = new Set(panel.boundRoles)
    return (
      <div
        data-testid="dc-remote-view"
        className="flex flex-col gap-3 rounded-2xl border border-border bg-background-elevated p-3"
      >
        <OverlayBar onBack={onBack}>{title}</OverlayBar>
        <div className="mx-auto w-full max-w-xs">
          <RemoteGrid
            grid={panel.layout}
            label={title}
            boundRoles={bound}
            onSelect={(id) => {
              const role = panel.layout.buttons.find((button) => button.id === id)?.role
              if (role === undefined || !bound.has(role)) return
              onKey(role)
            }}
            renderWidget={
              panel.sources.length === 0
                ? undefined
                : (button, placement) => (
                    <SourceSelectKey
                      deviceId={panel.deviceId}
                      button={button}
                      sources={panel.sources}
                      current={panel.currentSource}
                      placement={placement}
                    />
                  )
            }
          />
        </div>
        {extra}
      </div>
    )
  }
  if (layoutPending) {
    return (
      <div
        data-testid="dc-remote-view"
        className="flex flex-col gap-3 rounded-2xl border border-border bg-background-elevated p-3"
      >
        <OverlayBar onBack={onBack}>{title}</OverlayBar>
        {extra}
      </div>
    )
  }
  const button = (k: CardRemoteKey, pos?: string): ReactElement => (
    <RemoteKeyButton
      key={k.id}
      k={k}
      pos={pos}
      flashed={flashed === k.id}
      onPress={(id) => {
        setFlashed(id)
        onKey(id)
      }}
      onFlashEnd={() => setFlashed(null)}
    />
  )
  return (
    <div
      data-testid="dc-remote-view"
      className="flex flex-col gap-3 rounded-2xl border border-border bg-background-elevated p-3"
    >
      <OverlayBar onBack={onBack}>{t('uiLibrary.deviceCard.remote', 'Remote')}</OverlayBar>
      {keys.length === 0 ? null : rows === null ? (
        <div className="flex flex-wrap justify-center gap-2">{keys.map((k) => button(k))}</div>
      ) : (
        <div className="grid justify-items-center gap-2.5" data-testid="dc-remote-pad">
          {rows.map((row) =>
            row.kind === 'dpad' ? (
              <div key="dpad" className="dc-remote-dpad">
                {row.keys.map((k) => button(k, k.id))}
              </div>
            ) : row.kind === 'pairs' ? (
              <div key="pairs" className="grid grid-cols-2 gap-x-7 gap-y-2">
                {row.keys.map((k) => button(k))}
              </div>
            ) : (
              <div key={row.keys[0]?.id ?? 'row'} className="flex flex-wrap justify-center gap-2">
                {row.keys.map((k) => button(k))}
              </div>
            ),
          )}
        </div>
      )}
      {extra}
      {keys.length === 0 ? null : (
        <p className="text-center text-xs text-foreground-muted">
          {t('uiLibrary.deviceCard.remoteNote', 'The keys are the ones the device declares.')}
        </p>
      )}
    </div>
  )
}
