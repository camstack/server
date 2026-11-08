import type { HeroAction, HeroCall, HeroConfirm } from '@camstack/types'
import {
  Skeleton,
  useAlertIfAvailable,
  useConfirm,
  useDeviceManagerGetBindings,
  useHeroLayoutGetHeroModel,
  useTrpcClient,
} from '@camstack/ui-library'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RemoteHeroButton } from '../../../components/remote/RemoteHeroButton'
import { callHeroAction } from './call-hero-action'
import { HeroModelCard } from './HeroModelCard'
import { heroLang, heroModelCovers } from './hero-model-view'
import { useHeroLiveRefresh } from './use-hero-live-refresh'

const CONFIRM_COPY: Readonly<
  Record<HeroConfirm, { title: string; message: string; confirm: string }>
> = {
  'off-while-running': {
    title: 'Turn off while running?',
    message: 'The device is running. Cutting its power now interrupts what it is doing.',
    confirm: 'Turn off',
  },
  unlock: {
    title: 'Unlock?',
    message: 'The lock will open.',
    confirm: 'Unlock',
  },
  install: {
    title: 'Install the update?',
    message: 'The device may restart and be unavailable for a while.',
    confirm: 'Install',
  },
  press: {
    title: 'Run it now?',
    message: 'The device acts as soon as you confirm.',
    confirm: 'Run',
  },
}

/** The i18n namespace of a confirmation; the first one predates the others. */
const confirmKey = (kind: HeroConfirm): string =>
  kind === 'off-while-running' ? 'deviceHero.model.confirmOff' : `deviceHero.model.confirm.${kind}`

export interface ModelHeroProps {
  readonly deviceId: number
  readonly canActuate: boolean
  /** Drawn while the model does not cover the device (or could not be read). */
  readonly fallback: ReactNode
  /** Opens the device's history; absent when the page has no history to open. */
  readonly onOpenHistory?: () => void
  /** Told whether the model hero (not the fallback) is what is on screen. */
  readonly onDrawn?: (drawn: boolean) => void
}

/**
 * The device hero drawn from the hero model (D1023). While the model or the
 * bindings are unanswered a skeleton shows; when the model is absent, errored or
 * does not cover the device's caps yet, `fallback` (the legacy hero) renders.
 */
export function ModelHero({
  deviceId,
  canActuate,
  fallback,
  onOpenHistory,
  onDrawn,
}: ModelHeroProps): ReactNode {
  const { t, i18n } = useTranslation()
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
          const ok = await confirm({
            title: t(`${confirmKey(action.confirm)}.title`, CONFIRM_COPY[action.confirm].title),
            message: t(
              `${confirmKey(action.confirm)}.message`,
              CONFIRM_COPY[action.confirm].message,
            ),
            confirmLabel: t(
              `${confirmKey(action.confirm)}.confirm`,
              CONFIRM_COPY[action.confirm].confirm,
            ),
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
            title: t('deviceHero.model.callFailed', 'The device did not accept the command'),
            message: err instanceof Error ? err.message : String(err),
            variant: 'danger',
          })
        } finally {
          setBusy(false)
        }
      })()
    },
    [alert, bindings.data, confirm, deviceId, model, client, t],
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
          lang: heroLang(i18n.language),
          busy,
          run,
          ...(onOpenHistory === undefined ? {} : { openHistory: onOpenHistory }),
        }}
        remote={<RemoteHeroButton deviceId={deviceId} deviceName={built.name} />}
      />
    </div>
  )
}
