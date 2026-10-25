/**
 * The device CA: the authority that signs every device certificate. It is
 * created lazily by the first enrollment (so `absent` is normal on a hub that
 * paired nothing yet) and `unavailable` means the keychain could not answer —
 * the reason is shown, never an empty card.
 */
import { Badge, SettingRow, trpc } from '@camstack/ui-library'
import { ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'

import { AccessSection } from '../access/AccessSection'
import { QueryBody } from './QueryBody'
import { useTranslation } from 'react-i18next'

export function DeviceCaCard(): ReactNode {
  const { t } = useTranslation()
  const query = trpc.deviceCredentials.getDeviceCaStatus.useQuery({})
  const ca = query.data
  return (
    <AccessSection
      id="device-ca"
      title={t(
        'certificates.deviceCaCard.deviceCertificateAuthority',
        'Device certificate authority',
      )}
      icon={ShieldCheck}
      description={t(
        'certificates.deviceCaCard.signsTheCertificateEachPaired',
        'Signs the certificate each paired device holds. It is created the first time a device is paired.',
      )}
    >
      <QueryBody
        isPending={query.isPending}
        error={query.error}
        what="the device CA"
        onRetry={() => void query.refetch()}
      >
        {ca !== undefined && (
          <div className="space-y-1" data-testid="device-ca-status">
            <SettingRow label={t('certificates.deviceCaCard.state', 'State')}>
              {ca.state === 'ready' && (
                <Badge variant="success">{t('certificates.deviceCaCard.ready', 'Ready')}</Badge>
              )}
              {ca.state === 'absent' && (
                <Badge variant="default">
                  {t('certificates.deviceCaCard.notCreatedYet', 'Not created yet')}
                </Badge>
              )}
              {ca.state === 'unavailable' && (
                <Badge variant="danger">
                  {t('certificates.deviceCaCard.unavailable', 'Unavailable')}
                </Badge>
              )}
            </SettingRow>
            {ca.state === 'ready' && (
              <>
                <SettingRow
                  label={t('certificates.deviceCaCard.subject', 'Subject')}
                  valueClassName="font-mono"
                >
                  {ca.subject}
                </SettingRow>
                <SettingRow
                  label={t('certificates.deviceCaCard.fingerprintSha256', 'Fingerprint (SHA-256)')}
                  valueClassName="font-mono"
                >
                  {ca.fingerprintSha256}
                </SettingRow>
                <SettingRow label={t('certificates.deviceCaCard.validUntil', 'Valid until')}>
                  {ca.validTo}
                </SettingRow>
              </>
            )}
            {ca.state === 'unavailable' && (
              <SettingRow label={t('certificates.deviceCaCard.reason', 'Reason')}>
                <span className="text-danger">{ca.reason}</span>
              </SettingRow>
            )}
          </div>
        )}
      </QueryBody>
    </AccessSection>
  )
}
