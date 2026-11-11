import {
  ConfirmDialogProvider,
  ConnectedDeviceCard,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  TrpcClientProvider,
  UiTextProvider,
  DeviceHistoryView,
  heroLang,
  ModelHero,
  Skeleton,
  trpc,
  useConnectedCardKind,
  useDeviceSeriesList,
  useIsPhone,
} from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'
import { bridgeUiText } from '../../i18n/ui-text-bridge'
import { historyTabVisible } from '../../components/device/history-tab'
import { RemoteHeroButton } from '../../components/remote/RemoteHeroButton'
import { DeviceModuleProvider } from './module-context'
import { useHeroLabels } from './use-hero-labels'
import type { DeviceDetailModuleProps } from './types'

/** One cache per mounted module when the host does not lend its own. */
function useOwnQueryClient(lent: QueryClient | undefined): QueryClient {
  const [own] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
      }),
  )
  return lent ?? own
}

/**
 * The device card (plug, climate) of a device the card model already draws. It
 * carries its own history and remote views, so the module adds nothing around it.
 */
function CardBody({
  deviceId,
  kind,
  canActuate,
  onDrawn,
}: Pick<DeviceDetailModuleProps, 'deviceId' | 'onDrawn'> & {
  readonly kind: 'plug' | 'climate'
  readonly canActuate: boolean
}): ReactNode {
  const phone = useIsPhone()
  useEffect(() => {
    onDrawn?.(true)
  }, [onDrawn])
  return (
    <div className="flex justify-center">
      <ConnectedDeviceCard
        kind={kind}
        deviceId={deviceId}
        canActuate={canActuate}
        orientation={phone ? 'vertical' : 'horizontal'}
      />
    </div>
  )
}

function ModuleBody(
  props: Pick<
    DeviceDetailModuleProps,
    'deviceId' | 'fallback' | 'onDrawn' | 'defaultHistoryOpen'
  > & {
    readonly canActuate: boolean
  },
): ReactNode {
  const kind = useConnectedCardKind(props.deviceId)
  if (kind === 'pending') return <Skeleton className="h-72 w-full" />
  if (kind !== null) {
    return (
      <CardBody
        deviceId={props.deviceId}
        kind={kind}
        canActuate={props.canActuate}
        onDrawn={props.onDrawn}
      />
    )
  }
  return <HeroBody {...props} />
}

function HeroBody({
  deviceId,
  canActuate,
  fallback,
  onDrawn,
  defaultHistoryOpen,
  showName,
}: Pick<
  DeviceDetailModuleProps,
  'deviceId' | 'fallback' | 'onDrawn' | 'defaultHistoryOpen' | 'showName'
> & {
  readonly canActuate: boolean
}): ReactNode {
  const { t, i18n } = useTranslation()
  const labels = useHeroLabels()
  const [historyOpen, setHistoryOpen] = useState(defaultHistoryOpen === true)
  const series = useDeviceSeriesList(deviceId)
  const hasHistory = historyTabVisible(series.presence, series.list)
  const openHistory = useCallback(() => setHistoryOpen(true), [])
  return (
    <>
      <ModelHero
        deviceId={deviceId}
        canActuate={canActuate}
        lang={heroLang(i18n.language)}
        labels={labels}
        renderRemote={(deviceName) => (
          <RemoteHeroButton deviceId={deviceId} deviceName={deviceName} />
        )}
        fallback={fallback ?? null}
        showName={showName !== false}
        {...(hasHistory ? { onOpenHistory: openHistory } : {})}
        {...(onDrawn === undefined ? {} : { onDrawn })}
      />
      {historyOpen ? (
        <Dialog open onOpenChange={(open) => !open && setHistoryOpen(false)}>
          <DialogContent width="xl" scroll="body">
            <DialogHeader>
              <DialogTitle>{t('deviceModule.history', 'History')}</DialogTitle>
            </DialogHeader>
            <DialogBody className="mt-3">
              <DeviceHistoryView deviceId={deviceId} />
            </DialogBody>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}

/**
 * The device detail as ONE web module: the layout-A hero card, the device's
 * History (with its runs / cycles) and every action a row or control names, for
 * one device. Props only - it reads no router, layout, sidebar or global store -
 * so the admin UI mounts it directly and the viewer loads the same bundle in a
 * WebView. Live updates come from the device's state slices (`useDeviceProxy`).
 */
export function DeviceDetailModule({
  deviceId,
  trpcClient,
  theme,
  locale,
  canActuate = false,
  defaultHistoryOpen,
  queryClient,
  fallback,
  onDrawn,
  onOpenDevice,
  onOpenCamera,
  onClose,
  onNavigate,
  showName,
}: DeviceDetailModuleProps): ReactNode {
  const client = useOwnQueryClient(queryClient)
  const moduleI18n = useMemo(() => i18n.cloneInstance({ lng: locale }), [locale])
  const uiText = useMemo(() => bridgeUiText(moduleI18n.t.bind(moduleI18n)), [moduleI18n])
  const navigation = useMemo(
    () => ({ onOpenDevice, onOpenCamera, onClose, onNavigate }),
    [onOpenDevice, onOpenCamera, onClose, onNavigate],
  )
  return (
    <div className={theme} data-theme={theme} data-testid="device-detail-module">
      <I18nextProvider i18n={moduleI18n}>
        <UiTextProvider t={uiText}>
          <TrpcClientProvider client={trpcClient}>
            <trpc.Provider client={trpcClient} queryClient={client}>
              <QueryClientProvider client={client}>
                <ConfirmDialogProvider>
                  <DeviceModuleProvider value={navigation}>
                    <ModuleBody
                      deviceId={deviceId}
                      canActuate={canActuate}
                      fallback={fallback}
                      onDrawn={onDrawn}
                      defaultHistoryOpen={defaultHistoryOpen}
                      showName={showName}
                    />
                  </DeviceModuleProvider>
                </ConfirmDialogProvider>
              </QueryClientProvider>
            </trpc.Provider>
          </TrpcClientProvider>
        </UiTextProvider>
      </I18nextProvider>
    </div>
  )
}
