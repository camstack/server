import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react'
import { cn } from '../../../lib/cn'
import { useUiText } from '../../../contexts/ui-text'
import { DEVICE_CARD_CSS } from '../card-css'
import { ValueChip } from '../parts/ValueChip'
import { ConsumablesButton, ReasonLine, SupplyChip } from './BottomLine'
import { BatteryCorner, PowerCorner, RemoteCorner, StateCorner } from './Corner'
import { type CardGating, CardGatingProvider } from './gating'
import type { CardCommon, CardCommonActions, CardOrientation, CardState } from './model'
import { HistoryView, RemoteView } from './Overlays'
import { SceneGrid, type SceneZones } from './SceneGrid'

export interface DeviceCardProps {
  /** The device type the scene draws (`plug`, `climate`): a hook for specs and shots. */
  readonly kind: string
  readonly common: CardCommon
  readonly actions?: CardCommonActions
  readonly orientation?: CardOrientation
  readonly state: CardState
  /** What the device is doing, for the scene's colour and animation. */
  readonly activity?: string
  readonly scene: SceneZones
  readonly className?: string
  /** Draw the device name (default true); false when the host already names the device. */
  readonly showName?: boolean
  /** Controls the remote sheet draws under the keys (a media player's shuffle and repeat). */
  readonly remoteExtra?: ReactNode
  /** Opens on this view. The shot harness uses `remote` so the sheet is on screen. */
  readonly initialView?: DeviceCardView
  /**
   * `card` (default): the card's own frame — border, surface, padding, max width
   * and the top line. `bare`: only the scene and what hangs under it, full width
   * on the host's background; the host draws integration and reachability in
   * its own header (the viewer's device sheet). Defaults to the nearest
   * {@link DeviceCardFrameProvider}, so a host frames every card it mounts.
   */
  readonly frame?: DeviceCardFrame
}

export type DeviceCardView = 'scene' | 'history' | 'remote'

/** How a card is framed: its own card, or bare inside a host that frames it. */
export type DeviceCardFrame = 'card' | 'bare'

const DeviceCardFrameContext = createContext<DeviceCardFrame>('card')

export interface DeviceCardFrameProviderProps {
  readonly frame: DeviceCardFrame
  readonly children: ReactNode
}

/** Frames every device card below it — a host page that draws the frame itself. */
export function DeviceCardFrameProvider({
  frame,
  children,
}: DeviceCardFrameProviderProps): ReactElement {
  return <DeviceCardFrameContext.Provider value={frame}>{children}</DeviceCardFrameContext.Provider>
}

/** Integration on the left, reachability on the right. */
export function CardTop({ common }: { readonly common: CardCommon }): ReactElement {
  const t = useUiText()
  return (
    <div className="flex items-center justify-between gap-2" data-testid="dc-top">
      {common.integration === null ? <span /> : <ValueChip>{common.integration}</ValueChip>}
      {common.online === null ? (
        <span className="text-xs text-foreground-subtle" data-testid="dc-reach-unknown">
          {t('uiLibrary.deviceCard.reachUnknown', 'Status unknown')}
        </span>
      ) : common.online ? (
        <span
          className="inline-flex items-center gap-1.5 text-xs text-foreground-muted"
          data-testid="dc-reach-online"
        >
          <span className="h-2 w-2 rounded-full bg-foreground-muted" />
          {t('uiLibrary.deviceCard.online', 'Online')}
        </span>
      ) : (
        <ValueChip tone="danger">
          {common.offlineLabel ?? t('uiLibrary.deviceCard.offline', 'Offline')}
        </ValueChip>
      )}
    </div>
  )
}

function useGating(common: CardCommon): CardGating {
  const t = useUiText()
  return useMemo(() => {
    if (common.online === false) {
      // The top line already says "Offline for …": the controls are disabled
      // without repeating it underneath.
      return { blocked: true, reason: null }
    }
    if (common.readOnly) {
      return {
        blocked: true,
        reason: t(
          'uiLibrary.deviceCard.reason.readOnly',
          'Read only: you do not have permission to command it',
        ),
      }
    }
    return { blocked: false, reason: null }
  }, [common.online, common.readOnly, t])
}

/**
 * The device card: ONE frame for every device type. It owns the top line, the
 * four corners, the bottom line, the history and remote views and the gating;
 * a scene only fills the zones.
 */
export function DeviceCard({
  kind,
  common,
  actions,
  orientation = 'vertical',
  state,
  activity,
  scene,
  className,
  showName = true,
  remoteExtra = null,
  initialView = 'scene',
  frame,
}: DeviceCardProps): ReactElement {
  const hostFrame = useContext(DeviceCardFrameContext)
  const bare = (frame ?? hostFrame) === 'bare'
  const gating = useGating(common)
  const [view, setView] = useState<DeviceCardView>(initialView)
  const history = common.history
  const hasHistory = history !== null && (history.charts !== null || history.events !== null)
  const remoteKeys = common.remote ?? []
  const hasRemote = remoteKeys.length > 0 || remoteExtra != null
  const hasBottomLine =
    gating.reason !== null ||
    common.notice !== null ||
    common.supply !== null ||
    common.consumables !== null
  return (
    <CardGatingProvider value={gating}>
      <article
        data-testid="device-card"
        data-card-kind={kind}
        data-orientation={orientation}
        data-view={view}
        data-frame={bare ? 'bare' : 'card'}
        className={cn(
          'dc-card flex w-full flex-col gap-2.5 text-foreground',
          !bare && 'rounded-3xl border border-border bg-surface p-3.5',
          !bare && (orientation === 'vertical' ? 'max-w-85' : 'max-w-180'),
          gating.blocked && 'dc-blocked',
          className,
        )}
      >
        <style>{DEVICE_CARD_CSS}</style>
        {bare ? null : <CardTop common={common} />}
        {showName ? (
          <h3 className="text-xl font-semibold leading-tight" data-testid="dc-name">
            {common.name}
          </h3>
        ) : null}
        {view === 'history' && history !== null ? (
          <HistoryView state={state} history={history} onBack={() => setView('scene')} />
        ) : view === 'remote' && hasRemote ? (
          <RemoteView
            keys={remoteKeys}
            extra={remoteExtra}
            onKey={(id) => actions?.onRemoteKey?.(id)}
            onBack={() => setView('scene')}
          />
        ) : (
          <SceneGrid
            {...scene}
            activity={activity}
            bottomCorners={common.battery !== null || hasRemote}
            corners={
              <>
                <StateCorner
                  state={state}
                  {...(hasHistory ? { onOpenHistory: () => setView('history') } : {})}
                />
                {common.power === null ? null : <PowerCorner power={common.power} />}
                {common.battery === null ? null : <BatteryCorner level={common.battery.level} />}
                {hasRemote ? <RemoteCorner onOpen={() => setView('remote')} /> : null}
              </>
            }
          />
        )}
        {hasBottomLine ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="dc-bottom-line">
            <ReasonLine notice={common.notice} />
            {common.supply === null ? null : (
              <SupplyChip
                supply={common.supply}
                readOnly={common.readOnly}
                onAction={(a) => actions?.onSupply?.(a)}
              />
            )}
            {common.consumables === null || common.consumables.length === 0 ? null : (
              <ConsumablesButton
                items={common.consumables}
                onReset={(key) => actions?.onConsumableReset?.(key)}
              />
            )}
          </div>
        ) : null}
      </article>
    </CardGatingProvider>
  )
}
