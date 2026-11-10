import type { HeroAction, HeroCall } from '@camstack/types'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTrpcClient } from '../../contexts/system-context'
import { Skeleton } from '../../primitives/skeleton'
import {
  useDeviceManagerGetBindings,
  useHeroLayoutGetHeroModel,
} from '../../generated/system-hooks'
import { useAlertIfAvailable, useConfirm } from '../confirm-dialog'
import { callHeroAction } from './call-hero-action'
import type { HeroLabels } from './hero-labels'
import { HeroModelCard } from './HeroModelCard'
import { type HeroLang, heroModelCovers } from './hero-model-view'
import { useHeroLiveRefresh } from './use-hero-live-refresh'

export interface ModelHeroProps {
  readonly deviceId: number
  readonly canActuate: boolean
  /** The language the model's own `{ en, it }` texts are picked in. */
  readonly lang: HeroLang
  /** The words the model does not carry, in `lang`. */
  readonly labels: HeroLabels
  /** Drawn while the model does not cover the device (or could not be read). */
  readonly fallback: ReactNode
  /** Opens the device's history; absent when the host has no history to open. */
  readonly onOpenHistory?: () => void
  /** The remote's foot button for a device whose model carries the `remote` slot; given the device name. */
  readonly renderRemote?: (deviceName: string) => ReactNode
  /** Told whether the model hero (not the fallback) is what is on screen. */
  readonly onDrawn?: (drawn: boolean) => void
}

/**
 * The device hero drawn from the hero model (D1023), mountable by any host that
 * provides the tRPC client (`TrpcClientProvider` / `SystemProvider`) and a
 * confirm dialog. While the model or the bindings are unanswered a skeleton
 * shows; when the model is absent, errored or does not cover the device's caps
 * yet, `fallback` renders.
 */
export function ModelHero({
  deviceId,
  canActuate,
  lang,
  labels,
  fallback,
  onOpenHistory,
  renderRemote,
  onDrawn,
}: ModelHeroProps): ReactNode {
  const client = useTrpcClient()
  const confirm = useConfirm()
  const alert = useAlertIfAvailable()
  const [busy, setBusy] = useState(false)
  const model = useHeroLayoutGetHeroModel({ deviceId, canActuate })
  useHeroLiveRefresh(deviceId, model.refetch)
  const bindings = useDeviceManagerGetBindings({ deviceId })

  const run = useCallback(
    (call: HeroCall, action: HeroAction | null): void => {
      void (async () => {
        if (action?.confirm != null) {
          const copy = labels.confirm[action.confirm]
          const ok = await confirm({
            title: copy.title,
            message: copy.message,
            confirmLabel: copy.confirm,
            variant: action.confirm === 'press' ? 'default' : 'danger',
          })
          if (!ok) return
        }
        const nodeId = bindings.data?.entries.find((e) => e.capName === call.cap)?.providerNodeId
        setBusy(true)
        try {
          await callHeroAction(client, call, deviceId, nodeId)
          await model.refetch()
        } catch (err) {
          await alert?.({
            title: labels.callFailed,
            message: err instanceof Error ? err.message : String(err),
            variant: 'danger',
          })
        } finally {
          setBusy(false)
        }
      })()
    },
    [alert, bindings.data, confirm, deviceId, model, client, labels],
  )

  const drawn =
    model.status === 'success' &&
    bindings.status === 'success' &&
    model.data !== null &&
    model.data !== undefined &&
    heroModelCovers(
      model.data,
      bindings.data.entries.map((e) => e.capName),
    )
  useEffect(() => {
    onDrawn?.(drawn)
  }, [drawn, onDrawn])

  if (model.status === 'pending' || bindings.status === 'pending') {
    return <Skeleton className="h-72 w-full" />
  }
  const built = model.data
  if (
    model.status === 'error' ||
    bindings.status === 'error' ||
    built === null ||
    built === undefined ||
    !heroModelCovers(
      built,
      bindings.data.entries.map((e) => e.capName),
    )
  ) {
    return <>{fallback}</>
  }
  return (
    <div className="p-3 sm:p-4">
      <HeroModelCard
        model={built}
        host={{
          lang,
          labels,
          busy,
          run,
          ...(onOpenHistory === undefined ? {} : { openHistory: onOpenHistory }),
        }}
        remote={renderRemote?.(built.name)}
      />
    </div>
  )
}
