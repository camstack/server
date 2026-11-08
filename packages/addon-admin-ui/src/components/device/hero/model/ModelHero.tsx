import type { HeroAction, HeroCall } from '@camstack/types'
import {
  Skeleton,
  useAlertIfAvailable,
  useConfirm,
  useDeviceManagerGetBindings,
  useHeroLayoutGetHeroModel,
  useSystem,
} from '@camstack/ui-library'
import { type ReactNode, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RemoteHeroButton } from '../../../remote/RemoteHeroButton'
import { callHeroAction } from './call-hero-action'
import { HeroModelCard } from './HeroModelCard'
import { heroLang, heroModelCovers } from './hero-model-view'

const MODEL_REFRESH_MS = 5_000

export interface ModelHeroProps {
  readonly deviceId: number
  readonly deviceName: string
  readonly canActuate: boolean
  /** Drawn while the model does not cover the device (or could not be read). */
  readonly fallback: ReactNode
}

/**
 * The device hero drawn from the hero model (D1023). While the model or the
 * bindings are unanswered a skeleton shows; when the model is absent, errored or
 * does not cover the device's caps yet, `fallback` (the legacy hero) renders.
 */
export function ModelHero({
  deviceId,
  deviceName,
  canActuate,
  fallback,
}: ModelHeroProps): ReactNode {
  const { t, i18n } = useTranslation()
  const system = useSystem()
  const confirm = useConfirm()
  const alert = useAlertIfAvailable()
  const [busy, setBusy] = useState(false)
  const model = useHeroLayoutGetHeroModel(
    { deviceId, canActuate },
    { refetchInterval: MODEL_REFRESH_MS },
  )
  const bindings = useDeviceManagerGetBindings({ deviceId })

  const run = useCallback(
    (call: HeroCall, action: HeroAction | null): void => {
      void (async () => {
        if (action?.confirm === 'off-while-running') {
          const ok = await confirm({
            title: t('deviceHero.model.confirmOff.title', 'Turn off while running?'),
            message: t(
              'deviceHero.model.confirmOff.message',
              'The device is running. Cutting its power now interrupts what it is doing.',
            ),
            confirmLabel: t('deviceHero.model.confirmOff.confirm', 'Turn off'),
            variant: 'danger',
          })
          if (!ok) return
        }
        const nodeId = bindings.data?.entries.find((e) => e.capName === call.cap)?.providerNodeId
        setBusy(true)
        try {
          await callHeroAction(system.trpcClient, call, deviceId, nodeId)
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
    [alert, bindings.data, confirm, deviceId, model, system.trpcClient, t],
  )

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
        host={{ lang: heroLang(i18n.language), busy, run }}
        remote={<RemoteHeroButton deviceId={deviceId} deviceName={deviceName} />}
      />
    </div>
  )
}
