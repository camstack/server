import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import { cn } from '../../../lib/cn'
import { useUiText } from '../../../contexts/ui-text'
import { DEVICE_CARD_CSS } from '../card-css'
import { ValueChip } from '../parts/ValueChip'
import { ConsumablesButton, ReasonLine, SupplyChip } from './BottomLine'
import { BatteryCorner, MotionCorner, PowerCorner, RemoteCorner, StateCorner } from './Corner'
import { type CardGating, CardGatingProvider } from './gating'
import type { CardCommon, CardCommonActions, CardOrientation, CardState } from './model'
import { HistoryView, RemoteView } from './Overlays'
import { OverlayBoxProvider } from './overlay-box'
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
const DeviceCardFillContext = createContext<boolean>(false)

export interface DeviceCardFrameProviderProps {
  readonly frame: DeviceCardFrame
  /**
   * The host gave the card a definite height (the viewer's sheet): the card
   * takes all of it and the History / Remote overlays fill it, so the views
   * swap in one box. The host's own chain must be `h-full` down to the card.
   */
  readonly fill?: boolean
  readonly children: ReactNode
}

/** The frame the nearest {@link DeviceCardFrameProvider} asks for (default `card`). */
export function useDeviceCardFrame(): DeviceCardFrame {
  return useContext(DeviceCardFrameContext)
}

/** Frames every device card below it — a host page that draws the frame itself. */
export function DeviceCardFrameProvider({
  frame,
  fill = false,
  children,
}: DeviceCardFrameProviderProps): ReactElement {
  return (
    <DeviceCardFrameContext.Provider value={frame}>
      <DeviceCardFillContext.Provider value={fill}>{children}</DeviceCardFillContext.Provider>
    </DeviceCardFrameContext.Provider>
  )
}

/**
 * Integration on the left, reachability on the right. Reachable is the normal
 * state and says nothing (operator rule: the admin never prints "Online");
 * only offline, and a status not yet known, take the corner.
 */
export function CardTop({ common }: { readonly common: CardCommon }): ReactElement | null {
  const t = useUiText()
  const fault = common.fault ?? null
  if (common.integration === null && common.online === true && fault === null) return null
  return (
    <div className="flex items-center justify-between gap-2" data-testid="dc-top">
      {common.integration === null ? <span /> : <ValueChip>{common.integration}</ValueChip>}
      <div className="flex items-center gap-2">
        {fault !== null ? (
          <ValueChip
            glyph="warning"
            tone={fault.severity === 'error' ? 'danger' : 'warning'}
            data-testid="dc-fault"
          >
            {fault.label.length > 0 ? fault.label : t('uiLibrary.deviceCard.fault', 'Fault')}
          </ValueChip>
        ) : null}
        {common.online === null ? (
          <span className="text-xs text-foreground-subtle" data-testid="dc-reach-unknown">
            {t('uiLibrary.deviceCard.reachUnknown', 'Status unknown')}
          </span>
        ) : common.online ? null : (
          <ValueChip tone="danger">
            {common.offlineLabel ?? t('uiLibrary.deviceCard.offline', 'Offline')}
          </ValueChip>
        )}
      </div>
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
  const fill = useContext(DeviceCardFillContext)
  const [view, setView] = useState<DeviceCardView>(initialView)
  // An overlay keeps the height of the detail it replaces (admin); measured
  // as the scene closes, because the scene is gone once the overlay draws.
  const sceneRef = useRef<HTMLDivElement>(null)
  const [sceneHeight, setSceneHeight] = useState<number | null>(null)
  const openView = (next: DeviceCardView): void => {
    const measured = sceneRef.current?.getBoundingClientRect().height ?? 0
    if (measured > 0) setSceneHeight(measured)
    setView(next)
  }
  const history = common.history
  const motion = common.motionTrigger ?? null
  const hasHistory =
    history !== null &&
    (history.charts !== null || history.events !== null || common.deviceId !== undefined)
  const remoteKeys = common.remote ?? []
  const remotePanel = common.remotePanel ?? null
  const remotePending = common.remoteLayoutPending === true
  const hasRemote =
    remoteKeys.length > 0 || remotePanel !== null || remotePending || remoteExtra != null
  const hasBottomLine =
    gating.reason !== null ||
    common.notice !== null ||
    common.supply !== null ||
    common.consumables !== null ||
    common.consumablesLoading === true
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
          fill && 'h-full min-h-0',
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
        <OverlayBoxProvider value={{ fill, height: sceneHeight }}>
          {view === 'history' && history !== null ? (
            <HistoryView
              state={state}
              history={history}
              onBack={() => setView('scene')}
              {...(common.deviceId === undefined ? {} : { deviceId: common.deviceId })}
            />
          ) : view === 'remote' && hasRemote ? (
            <RemoteView
              keys={remoteKeys}
              panel={remotePanel}
              layoutPending={remotePending}
              extra={remoteExtra}
              onKey={(id) => actions?.onRemoteKey?.(id)}
              onBack={() => setView('scene')}
            />
          ) : (
            <div ref={sceneRef} data-testid="dc-scene-box">
              <SceneGrid
                {...scene}
                activity={activity}
                bottomCorners={common.battery !== null || hasRemote || motion !== null}
                corners={
                  <>
                    <StateCorner
                      state={state}
                      {...(hasHistory ? { onOpenHistory: () => openView('history') } : {})}
                    />
                    {common.power === null ? null : <PowerCorner power={common.power} />}
                    {motion === null ? null : (
                      <MotionCorner
                        on={motion.on}
                        pending={motion.pending}
                        blocked={gating.blocked}
                        onToggle={(enabled) => actions?.onMotionTrigger?.(enabled)}
                      />
                    )}
                    {common.battery === null ? null : (
                      <BatteryCorner
                        shifted={motion !== null}
                        level={common.battery.level}
                        {...(common.battery.label === undefined
                          ? {}
                          : { label: common.battery.label })}
                      />
                    )}
                    {hasRemote ? <RemoteCorner onOpen={() => openView('remote')} /> : null}
                  </>
                }
              />
            </div>
          )}
        </OverlayBoxProvider>
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
            {common.consumables === null && common.consumablesLoading !== true ? null : (
              <ConsumablesButton
                items={common.consumables ?? []}
                loading={common.consumablesLoading === true}
                onReset={(key) => actions?.onConsumableReset?.(key)}
              />
            )}
          </div>
        ) : null}
      </article>
    </CardGatingProvider>
  )
}
