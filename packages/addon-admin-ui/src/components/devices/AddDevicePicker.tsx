import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorBox,
  Skeleton,
  useIntegrationsGetAvailableTypes,
  useIntegrationsList,
} from '@camstack/ui-library'
import { Plug } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { BROWSE_INTEGRATIONS_URL } from '../../lib/addon-kind-filter'
import {
  addDeviceUrl,
  computeAddDeviceTargets,
  setupIntegrationUrl,
} from '../../lib/add-device-targets'

interface AddDevicePickerProps {
  readonly open: boolean
  readonly onClose: () => void
}

/**
 * "Add device" on the Devices page: pick an installed integration, then land on
 * that integration's own add / scan / adopt flow (`?add=1`). Nothing here adds a
 * device itself.
 */
export function AddDevicePicker({ open, onClose }: AddDevicePickerProps): ReactNode {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const types = useIntegrationsGetAvailableTypes(undefined, { enabled: open })
  const integrations = useIntegrationsList(undefined, { enabled: open })

  const targets = useMemo(
    () =>
      types.data === undefined || integrations.data === undefined
        ? null
        : computeAddDeviceTargets(types.data, integrations.data),
    [types.data, integrations.data],
  )
  const failed = types.isError || integrations.isError

  const go = (url: string): void => {
    onClose()
    navigate(url)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile">
        <DialogHeader>
          <DialogTitle>{t('devices.addDevice.title', 'Add device')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {failed ? (
            <ErrorBox
              message={t('devices.addDevice.loadFailed', 'Integrations could not be loaded.')}
              onRetry={() => {
                void types.refetch()
                void integrations.refetch()
              }}
            />
          ) : targets === null ? (
            <div className="space-y-2" data-testid="add-device-pending">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : targets.length === 0 ? (
            <EmptyState
              icon={Plug}
              title={t('devices.addDevice.noneTitle', 'No integration installed')}
              description={t(
                'devices.addDevice.noneDescription',
                'Install an integration first, then add devices from it.',
              )}
              action={
                <Button onClick={() => go(BROWSE_INTEGRATIONS_URL)}>
                  {t('devices.browseIntegrations', 'Browse integrations')}
                </Button>
              }
            />
          ) : (
            <ul className="space-y-1.5">
              {targets.map((target) =>
                target.instances.length === 0 ? (
                  <li key={target.addonId}>
                    <Button
                      variant="outline"
                      className="w-full justify-between"
                      onClick={() => go(setupIntegrationUrl(target.addonId))}
                    >
                      <span className="truncate">{target.name}</span>
                      <span className="text-foreground-subtle">
                        {t('devices.addDevice.setUp', 'Set up')}
                      </span>
                    </Button>
                  </li>
                ) : (
                  target.instances.map((instance) => (
                    <li key={instance.id}>
                      <Button
                        variant="outline"
                        className="w-full justify-between"
                        onClick={() => go(addDeviceUrl(target.addonId, instance.id))}
                      >
                        <span className="truncate">{target.name}</span>
                        {instance.name !== target.name && (
                          <span className="truncate text-foreground-subtle">{instance.name}</span>
                        )}
                      </Button>
                    </li>
                  ))
                ),
              )}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
