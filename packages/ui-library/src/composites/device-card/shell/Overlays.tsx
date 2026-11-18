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
import { useOverlayBox } from './overlay-box'
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

interface ShellProps {
  readonly testId: string
  readonly onBack: () => void
  /** The bar's title: what the overlay is, or the state it replaced. */
  readonly title: ReactNode
  /** Pinned under the bar (the section switch). */
  readonly pinned?: ReactNode
  /** The overlay needs more room than the scene it replaced (stacked charts). */
  readonly roomy?: boolean
  readonly children: ReactNode
}

/**
 * The frame every overlay shares: a pinned top (back + title, then the
 * switch) and ONE scrolling region below. The box keeps the height of the
 * detail it replaced, or fills the host's height, so swapping views never
 * moves the page.
 */
function OverlayShell({
  testId,
  onBack,
  title,
  pinned,
  roomy = false,
  children,
}: ShellProps): ReactElement {
  const box = useOverlayBox()
  const locked = !box.fill && box.height !== null && box.height > 0
  return (
    <div
      data-testid={testId}
      data-locked={locked ? 'true' : undefined}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background-elevated',
        box.fill && 'flex-1',
        // History only: the scene's measured height is a floor, not the box,
        // because stacked charts need room. Capped at 60% of the viewport so a
        // phone keeps it. Every other overlay keeps the locked height.
        roomy && !box.fill && 'min-h-[min(28rem,60dvh)]',
      )}
      {...(locked ? { style: { height: box.height ?? undefined } } : {})}
    >
      <div className="flex shrink-0 flex-col gap-3 p-3 pb-2" data-testid="dc-overlay-top">
        <OverlayBar onBack={onBack}>{title}</OverlayBar>
        {pinned}
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-3 pt-1"
        data-testid="dc-overlay-scroll"
      >
        {children}
      </div>
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
    <OverlayShell
      testId="dc-history"
      roomy
      onBack={onBack}
      title={
        <>
          <span className={cardToneClass(state.tone)}>{state.label}</span>
          {state.since === null ? null : (
            <small className="ml-1 font-normal normal-case text-foreground-muted">
              · {state.since}
            </small>
          )}
        </>
      }
      pinned={
        <ViewSwitch
          options={paneOptions(panes, t)}
          value={pane}
          onChange={setChosen}
          ariaLabel={t('uiLibrary.deviceCard.history.sectionSwitch', 'History sections')}
          testId="dc-history-sections"
        />
      }
    >
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
    </OverlayShell>
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
      <OverlayShell testId="dc-remote-view" onBack={onBack} title={title}>
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
      </OverlayShell>
    )
  }
  if (layoutPending) {
    return (
      <OverlayShell testId="dc-remote-view" onBack={onBack} title={title}>
        {extra}
      </OverlayShell>
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
    <OverlayShell testId="dc-remote-view" onBack={onBack} title={title}>
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
    </OverlayShell>
  )
}
