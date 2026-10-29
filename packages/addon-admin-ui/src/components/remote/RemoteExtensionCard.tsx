/**
 * The Remote extension's card on a media player's Customize tab: what is
 * configured (layout, how many commands) and the door to the modal. It claims
 * "not configured" only from a config read that answered.
 */
import type { DeviceInfo } from '@camstack/types'
import { Button, useRemoteGetConfig, useTemplateList } from '@camstack/ui-library'
import { Gamepad2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomizeCard } from '../device/customize/CustomizeCard'
import { RemoteConfigDialog } from './RemoteConfigDialog'

export interface RemoteExtensionCardProps {
  readonly device: DeviceInfo
}

export function RemoteExtensionCard({ device }: RemoteExtensionCardProps): ReactNode {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const config = useRemoteGetConfig({ deviceId: device.id })
  const templates = useTemplateList({ kind: 'remote' })
  const stored = config.data
  const bindings = stored === undefined ? 0 : Object.keys(stored.bindings).length
  const templateName =
    stored?.layoutTemplateId == null
      ? null
      : ((templates.data ?? []).find((r) => r.id === stored.layoutTemplateId)?.name ?? null)
  return (
    <CustomizeCard
      id="remote"
      title={t('remote.card.title')}
      icon={Gamepad2}
      testId="customize-remote"
      actions={
        <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="remote-open">
          {t('remote.card.configure')}
        </Button>
      }
    >
      {config.status === 'error' ? (
        <p role="alert" className="text-xs text-danger">
          {config.error?.message ?? t('remote.dialog.unreadable')}
        </p>
      ) : stored === undefined ? (
        <p role="status" className="text-xs text-foreground-subtle">
          {t('remote.dialog.loading')}
        </p>
      ) : (
        <p className="text-xs text-foreground-muted" data-testid="remote-summary">
          {bindings === 0 && templateName === null
            ? t('remote.card.none')
            : t('remote.card.summary', {
                template: templateName ?? t('remote.dialog.noTemplate'),
                count: bindings,
              })}
        </p>
      )}
      {open && <RemoteConfigDialog device={device} open={open} onClose={() => setOpen(false)} />}
    </CustomizeCard>
  )
}
