/**
 * The hub-wide device-certificate setting: whether a signed-in user may enroll
 * their OWN device (`selfEnrollment`). An admin pairing someone's phone with a
 * QR is unaffected. The switch reflects the ANSWERED setting — until the hub
 * answers it is not drawn at all, so a default never reads as the stored value.
 */
import { SettingRow, Switch, trpc } from '@camstack/ui-library'
import { useState, type ReactNode } from 'react'

import { QueryBody } from './QueryBody'
import { useTranslation } from 'react-i18next'

export function DeviceSettingsRow(): ReactNode {
  const { t } = useTranslation()
  const utils = trpc.useUtils()
  const query = trpc.deviceCredentials.getDeviceCertificateSettings.useQuery({})
  const [error, setError] = useState<string | null>(null)
  const save = trpc.deviceCredentials.setDeviceCertificateSettings.useMutation({
    onSuccess: () => {
      setError(null)
      void utils.deviceCredentials.getDeviceCertificateSettings.invalidate()
    },
    onError: (err: { message: string }) => setError(`Could not save: ${err.message}`),
  })

  return (
    <QueryBody
      isPending={query.isPending}
      error={query.error}
      what="the enrollment setting"
      onRetry={() => void query.refetch()}
    >
      {query.data !== undefined && (
        <SettingRow
          label={t(
            'certificates.deviceSettingsRow.usersCanEnrollTheirOwn',
            'Users can enroll their own devices',
          )}
          actions={
            <Switch
              checked={query.data.selfEnrollment === 'allowed'}
              disabled={save.isPending}
              aria-label={t(
                'certificates.deviceSettingsRow.usersCanEnrollTheirOwn',
                'Users can enroll their own devices',
              )}
              onCheckedChange={(on) => save.mutate({ selfEnrollment: on ? 'allowed' : 'disabled' })}
            />
          }
        >
          <span className="text-[11px] text-foreground-subtle">
            {query.data.selfEnrollment === 'allowed'
              ? t(
                  'certificates.deviceSettingsRow.allowedAUserSignedIn',
                  'Allowed - a user signed in on a phone can keep it signed in. Pairing by QR works either way.',
                )
              : t(
                  'certificates.deviceSettingsRow.disabledOnlyAnAdminCan',
                  'Disabled - only an admin can pair a device, with a QR code.',
                )}
          </span>
          {error !== null && <span className="block text-[11px] text-danger">{error}</span>}
        </SettingRow>
      )}
    </QueryBody>
  )
}
