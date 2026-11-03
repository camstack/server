/**
 * The Remote button of a device's hero: opens a modal with the device's remote
 * layout, where a press sends the button's command (`remote.sendCommand`). It
 * self-gates: nothing is drawn until the `remote` capability is known present
 * and the device has at least one saved command — a device with only a remote
 * (no media-player binding) still gets it. The link to the layout template is
 * NOT here: it lives on the device's customization page (`RemoteExtensionCard`).
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  useCapabilityPresence,
  useRemoteGetConfig,
  useRemoteListCommands,
  useRemoteSendCommand,
  useTemplateList,
} from '@camstack/ui-library'
import { Gamepad2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { layoutOf } from './layout-model'
import { RemoteGrid } from './RemoteGrid'

export interface RemoteHeroButtonProps {
  readonly deviceId: number
  readonly deviceName: string
}

export function RemoteHeroButton({ deviceId, deviceName }: RemoteHeroButtonProps): ReactNode {
  const { t } = useTranslation()
  const presence = useCapabilityPresence('remote')
  const commands = useRemoteListCommands({ deviceId }, { enabled: presence === 'present' })
  const [open, setOpen] = useState(false)
  if (presence !== 'present') return null
  if ((commands.data?.commands.length ?? 0) === 0) return null
  return (
    <div className="flex flex-wrap items-center justify-center gap-1">
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="hero-remote">
        <Gamepad2 className="h-3.5 w-3.5" aria-hidden />
        {t('remote.hero.open')}
      </Button>
      {open && (
        <RemotePressDialog
          deviceId={deviceId}
          deviceName={deviceName}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

interface PressProps {
  readonly deviceId: number
  readonly deviceName: string
  readonly onClose: () => void
}

function RemotePressDialog({ deviceId, deviceName, onClose }: PressProps): ReactNode {
  const { t } = useTranslation()
  const config = useRemoteGetConfig({ deviceId })
  const templates = useTemplateList({ kind: 'remote' })
  const commands = useRemoteListCommands({ deviceId })
  const send = useRemoteSendCommand()
  const [failure, setFailure] = useState<string | null>(null)
  const templateId = config.data?.layoutTemplateId ?? null
  const template = (templates.data ?? []).find((r) => r.id === templateId)
  const layout = template === undefined ? null : layoutOf(template.payload)
  const bound = new Set((commands.data?.commands ?? []).map((c) => c.role))

  const press = async (buttonId: string): Promise<void> => {
    const role = layout?.buttons.find((b) => b.id === buttonId)?.role
    if (role === undefined || !bound.has(role)) return
    setFailure(null)
    try {
      const result = await send.mutateAsync({ deviceId, role, repeat: 1 })
      if (result.status === 'refused')
        setFailure(
          t(`remote.test.refused.${result.reason}`, {
            detail: result.detail ?? '',
          }),
        )
    } catch (err: unknown) {
      setFailure(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{t('remote.hero.title', { name: deviceName })}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {config.status === 'error' ? (
            <ErrorBox
              title={t('remote.dialog.unreadable')}
              message={config.error?.message ?? ''}
              onRetry={() => void config.refetch()}
            />
          ) : layout === null ? (
            <p className="text-xs text-foreground-muted">{t('remote.hero.noLayout')}</p>
          ) : (
            <div className="mx-auto w-full max-w-xs" data-testid="remote-press">
              <RemoteGrid
                grid={layout}
                label={t('remote.hero.title', { name: deviceName })}
                boundRoles={bound}
                onSelect={(id) => void press(id)}
              />
            </div>
          )}
          {failure !== null && (
            <p role="alert" className="text-xs text-danger">
              {failure}
            </p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
