import { type ReactElement, useMemo, useState } from 'react'
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
}

type CardView = 'scene' | 'history' | 'remote'

/** Integration on the left, reachability on the right. */
export function CardTop({ common }: { readonly common: CardCommon }): ReactElement {
  const t = useUiText()
  return (
    <div className="flex items-center justify-between gap-2" data-testid="dc-top">
      {common.integration === null ? <span /> : <ValueChip>{common.integration}</ValueChip>}
      {common.online ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-foreground-muted">
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
    if (!common.online) {
      return {
        blocked: true,
        reason: t('uiLibrary.deviceCard.reason.offline', '{{offline}}: commands unavailable', {
          offline: common.offlineLabel ?? t('uiLibrary.deviceCard.offline', 'Offline'),
        }),
      }
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
  }, [common.online, common.offlineLabel, common.readOnly, t])
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
}: DeviceCardProps): ReactElement {
  const gating = useGating(common)
  const [view, setView] = useState<CardView>('scene')
  const history = common.history
  const hasHistory = history !== null && (history.charts !== null || history.events !== null)
  const hasRemote = common.remote !== null && common.remote.length > 0
  const hasBottomLine =
    gating.reason !== null || common.supply !== null || common.consumables !== null
  return (
    <CardGatingProvider value={gating}>
      <article
        data-testid="device-card"
        data-card-kind={kind}
        data-orientation={orientation}
        data-view={view}
        className={cn(
          'flex w-full flex-col gap-2.5 rounded-3xl border border-border bg-surface p-3.5 text-foreground',
          orientation === 'vertical' ? 'max-w-85' : 'max-w-180',
          gating.blocked && 'dc-blocked',
          className,
        )}
      >
        <style>{DEVICE_CARD_CSS}</style>
        <CardTop common={common} />
        <h3 className="text-xl font-semibold leading-tight" data-testid="dc-name">
          {common.name}
        </h3>
        {view === 'history' && history !== null ? (
          <HistoryView state={state} history={history} onBack={() => setView('scene')} />
        ) : view === 'remote' && common.remote !== null ? (
          <RemoteView
            keys={common.remote}
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
            <ReasonLine />
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
