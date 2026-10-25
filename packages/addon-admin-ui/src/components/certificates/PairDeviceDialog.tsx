/**
 * "Pair a device" — an admin enrolls a phone for a user. Two steps in one
 * dialog: pick the user and name the device, then show the one-shot
 * enrollment link as a QR code, a copyable link and a countdown to its expiry.
 * The code is returned once and only its hash is kept, so closing the dialog
 * discards it: the fix for a lost QR is a new one.
 */
import {
  Button,
  CopyButton,
  FormField,
  Input,
  ItemFormDialog,
  QrCode,
  Select,
  trpc,
} from '@camstack/ui-library'
import { AlertTriangle, Loader2, Smartphone } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { countdown } from './certificate-model'
import { useNow } from './use-now'
import { useTranslation } from 'react-i18next'

const NAME_MAX = 80
const QR_SIZE_PX = 208

export interface PairUser {
  readonly id: string
  readonly username: string
}

export interface PairDeviceDialogProps {
  readonly open: boolean
  readonly users: readonly PairUser[]
  readonly onClose: () => void
  /** Called once a code was minted, so the table can refresh. */
  readonly onPaired: () => void
}

export function PairDeviceDialog({
  open,
  users,
  onClose,
  onPaired,
}: PairDeviceDialogProps): ReactNode {
  const { t } = useTranslation()
  const start = trpc.deviceCredentials.startEnrollment.useMutation({ onSuccess: onPaired })
  const [userId, setUserId] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const effectiveUser = userId !== '' ? userId : (users[0]?.id ?? '')
  const issued = start.data

  const close = (): void => {
    start.reset()
    setDeviceName('')
    onClose()
  }

  const submit = (): void => {
    const name = deviceName.trim()
    if (effectiveUser === '' || name === '') return
    start.mutate({ userId: effectiveUser, deviceName: name })
  }

  return (
    <ItemFormDialog
      open={open}
      onClose={close}
      title={t('certificates.pairDeviceDialog.pairADevice', 'Pair a device')}
      icon={Smartphone}
      width="md"
      testId="pair-device-dialog"
      error={start.isError ? start.error.message : null}
      footer={
        issued === undefined ? (
          <Button
            type="button"
            onClick={submit}
            disabled={start.isPending || effectiveUser === '' || deviceName.trim() === ''}
          >
            {start.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {t('certificates.pairDeviceDialog.createPairingCode', 'Create pairing code')}
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={close}>
            {t('certificates.pairDeviceDialog.done', 'Done')}
          </Button>
        )
      }
    >
      {issued === undefined ? (
        <div className="space-y-3">
          <p className="text-[11px] text-foreground-subtle">
            {t(
              'certificates.pairDeviceDialog.createsAOneTimeCode',
              'Creates a one-time code for a phone you hold. Scan it with the CamStack app on that phone; the phone then stays signed in as the chosen user until you revoke it.',
            )}
          </p>
          <FormField label={t('certificates.pairDeviceDialog.user', 'User')} required>
            <Select
              value={effectiveUser}
              onChange={(e) => setUserId(e.target.value)}
              options={users.map((u) => ({ value: u.id, label: u.username }))}
            />
          </FormField>
          <FormField
            label={t('certificates.pairDeviceDialog.deviceName', 'Device name')}
            required
            description={t(
              'certificates.pairDeviceDialog.howThisPhoneIsListed',
              "How this phone is listed, e.g. Anna's iPhone.",
            )}
          >
            <Input
              value={deviceName}
              maxLength={NAME_MAX}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder={t('certificates.pairDeviceDialog.annaSIphone', "Anna's iPhone")}
              autoFocus
            />
          </FormField>
        </div>
      ) : (
        <IssuedCode
          enrollUrl={issued.enrollUrl}
          expiresAt={issued.expiresAt}
          hubKnown={issued.hubOrigin !== null}
          onRestart={() => start.reset()}
        />
      )}
    </ItemFormDialog>
  )
}

interface IssuedCodeProps {
  readonly enrollUrl: string
  readonly expiresAt: number
  readonly hubKnown: boolean
  readonly onRestart: () => void
}

function IssuedCode({ enrollUrl, expiresAt, hubKnown, onRestart }: IssuedCodeProps): ReactNode {
  const { t } = useTranslation()
  const now = useNow(1000)
  const left = countdown(expiresAt, now)
  return (
    <div className="space-y-3" data-testid="pair-issued">
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        <div className={left.expired ? 'opacity-30' : undefined}>
          <QrCode
            value={enrollUrl}
            size={QR_SIZE_PX}
            alt={t('certificates.pairDeviceDialog.enrollmentQrCode', 'Enrollment QR code')}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-[11px] text-foreground-subtle">
            {t(
              'certificates.pairDeviceDialog.openTheCamstackAppOn',
              'Open the CamStack app on the phone and scan this code. It works once.',
            )}
          </p>
          <div
            className="text-sm font-semibold tabular-nums text-foreground"
            role="timer"
            data-testid="pair-countdown"
          >
            {left.expired
              ? t(
                  'certificates.pairDeviceDialog.expiredCreateANewCode',
                  'Expired - create a new code',
                )
              : t('certificates.pairDeviceDialog.expiresIn', 'Expires in {{label}}', {
                  label: left.label,
                })}
          </div>
          <div className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-[11px] text-foreground">
              {enrollUrl}
            </code>
            <CopyButton value={enrollUrl} srLabel="Enrollment link" />
          </div>
          {!hubKnown && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                {t(
                  'certificates.pairDeviceDialog.theHubCouldNotName',
                  'The hub could not name an address for this link, so the app must already know it.',
                )}
              </span>
            </div>
          )}
          {left.expired && (
            <Button type="button" variant="outline" size="sm" onClick={onRestart}>
              {t('certificates.pairDeviceDialog.newCode', 'New code')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
