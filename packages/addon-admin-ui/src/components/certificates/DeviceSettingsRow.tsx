/**
 * The hub-wide device-certificate setting: whether a signed-in user may enroll
 * their OWN device (`selfEnrollment`). An admin pairing someone's phone with a
 * QR is unaffected. The switch reflects the ANSWERED setting — until the hub
 * answers it is not drawn at all, so a default never reads as the stored value.
 */
import { FormSaveBar, SettingRow, Switch, trpc } from '@camstack/ui-library'
import { useState, type ReactNode } from 'react'

import { QueryBody } from './QueryBody'
import { useTranslation } from 'react-i18next'

type SelfEnrollment = 'allowed' | 'disabled'

export function DeviceSettingsRow(): ReactNode {
  const { t } = useTranslation()
  const utils = trpc.useUtils()
  const query = trpc.deviceCredentials.getDeviceCertificateSettings.useQuery({})
  const [error, setError] = useState<string | null>(null)
  /** The edit, held until Save; absent means the served value stands. */
  const [draft, setDraft] = useState<SelfEnrollment | null>(null)
  const save = trpc.deviceCredentials.setDeviceCertificateSettings.useMutation({
    onSuccess: () => {
      setError(null)
      setDraft(null)
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
        <>
          <SettingRow
            label={t(
              'certificates.deviceSettingsRow.usersCanEnrollTheirOwn',
              'Users can enroll their own devices',
            )}
            actions={
              <Switch
                checked={(draft ?? query.data.selfEnrollment) === 'allowed'}
                disabled={save.isPending}
                aria-label={t(
                  'certificates.deviceSettingsRow.usersCanEnrollTheirOwn',
                  'Users can enroll their own devices',
                )}
                onCheckedChange={(on) => setDraft(on ? 'allowed' : 'disabled')}
              />
            }
          >
            <span className="text-[11px] text-foreground-subtle">
              {(draft ?? query.data.selfEnrollment) === 'allowed'
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
          <FormSaveBar
            pendingCount={draft !== null && draft !== query.data.selfEnrollment ? 1 : 0}
            saving={save.isPending}
            onSave={() => draft !== null && save.mutate({ selfEnrollment: draft })}
            onDiscard={() => {
              setDraft(null)
              setError(null)
            }}
          />
        </>
      )}
    </QueryBody>
  )
}
