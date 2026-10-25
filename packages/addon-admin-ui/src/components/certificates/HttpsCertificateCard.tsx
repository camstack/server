/**
 * Identity → Certificates — the hub's HTTPS certificate (D873): generated
 * local CA or an uploaded pair. Regenerate / upload / revert / use-stored are
 * `local-network` cap *actions*, not a second settings store.
 */
import { useState, type ReactNode } from 'react'
import { Shield } from 'lucide-react'
import {
  Button,
  ConfirmActionButton,
  ErrorBox,
  SECTION_BODY,
  SectionCard,
  useLocalNetworkGetTlsStatus,
  useLocalNetworkRegenerateCertificate,
  useLocalNetworkRevertToGeneratedCertificate,
  useLocalNetworkUseStoredUploadedCertificate,
  useLocalNetworkUploadCertificate,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { checkPem } from '../../pages/system/pem-file'
import { PemField } from '../../pages/system/PemField'
import { useTranslation } from 'react-i18next'

const CA_REPLACED_NOTICE_DAYS = 30

/** The "re-install the CA" notice stays up for a month, long enough to reach every device. */
function isRecent(iso: string): boolean {
  const at = Date.parse(iso)
  return !Number.isNaN(at) && Date.now() - at < CA_REPLACED_NOTICE_DAYS * 86_400_000
}

function truncateFingerprint(value: string | null): string {
  if (value === null || value === '') return '—'
  const hex = value.replace(/:/g, '')
  if (hex.length <= 16) return value
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`
}

export function HttpsCertificateCard(): ReactNode {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const tlsQuery = useLocalNetworkGetTlsStatus(undefined, { refetchInterval: 15_000 })
  const regenerate = useLocalNetworkRegenerateCertificate({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['localNetwork']] }),
  })
  const revert = useLocalNetworkRevertToGeneratedCertificate({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['localNetwork']] }),
  })
  const useStored = useLocalNetworkUseStoredUploadedCertificate({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['localNetwork']] }),
  })
  const upload = useLocalNetworkUploadCertificate({
    onSuccess: () => {
      setUploadOpen(false)
      setCertPem('')
      setKeyPem('')
      setCaPem('')
      void queryClient.invalidateQueries({ queryKey: [['localNetwork']] })
    },
  })

  const tls = tlsQuery.data
  const [uploadOpen, setUploadOpen] = useState(false)
  const [certPem, setCertPem] = useState('')
  const [keyPem, setKeyPem] = useState('')
  const [caPem, setCaPem] = useState('')

  const handleDownloadCa = () => {
    if (!tls?.caCertPem) return
    const blob = new Blob([tls.caCertPem], { type: 'application/x-pem-file' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'camstack-ca.crt'
    a.click()
    URL.revokeObjectURL(url)
  }

  const modeLabel =
    tls?.mode === 'uploaded'
      ? 'Uploaded'
      : tls?.mode === 'generated'
        ? 'Generated local CA'
        : 'TLS disabled'

  return (
    <SectionCard
      headingId="local-access-certificate"
      title={t('system.localAccess.certificate', 'Certificate')}
      icon={Shield}
    >
      <div className={`${SECTION_BODY} space-y-3`}>
        {tlsQuery.isError && (
          <p className="text-xs text-danger">
            {t('system.localAccess.couldNotReadTlsStatus', 'Could not read TLS status.')}
          </p>
        )}
        {tls?.reissueError && (
          <ErrorBox
            variant="warning"
            title={t('system.localAccess.certificateReissue', 'Certificate reissue')}
            message={tls.reissueError}
          />
        )}
        {tls?.restartRequired && (
          <ErrorBox
            variant="warning"
            title={t('system.localAccess.restartRequired', 'Restart required')}
            message={t(
              'system.localAccess.theHttpsListenerStillServes',
              'The HTTPS listener still serves the previous certificate. Restart the hub to apply it.',
            )}
          />
        )}
        {tls?.caMissing === true && (
          <ErrorBox
            variant="warning"
            title={t(
              'system.localAccess.caMissingTitle',
              'CA missing - devices cannot trust this hub',
            )}
            message={t(
              'system.localAccess.caMissingBody',
              'The uploaded certificate was not issued by a public CA and no CA was stored with it, so Download CA has nothing to hand out. Upload the certificate again together with its CA (for mkcert, the rootCA.pem in the folder `mkcert -CAROOT` prints).',
            )}
          />
        )}
        {tls?.caReplacedAt != null && isRecent(tls.caReplacedAt) && (
          <ErrorBox
            variant="warning"
            title={t(
              'system.localAccess.caReplacedTitle',
              'The local CA was replaced - re-install it on your devices',
            )}
            message={t(
              'system.localAccess.caReplacedBody',
              'The previous local CA had no name constraints: if its key ever leaked it could vouch for any website. The hub now uses a CA limited to private addresses and local names. Download it again and trust it on every phone and computer that used the old one (replaced {{when}}).',
              { when: new Date(tls.caReplacedAt).toLocaleString() },
            )}
          />
        )}
        <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-foreground-subtle">{t('system.localAccess.mode', 'Mode')}</dt>
            <dd className="font-medium">{modeLabel}</dd>
          </div>
          <div>
            <dt className="text-foreground-subtle">
              {t('system.localAccess.validTo', 'Valid to')}
            </dt>
            <dd className="font-mono">
              {tls?.validTo ? new Date(tls.validTo).toLocaleString() : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-foreground-subtle">
              {t('system.localAccess.leafSha256', 'Leaf SHA-256')}
            </dt>
            <dd className="font-mono" title={tls?.leafFingerprintSha256 ?? undefined}>
              {truncateFingerprint(tls?.leafFingerprintSha256 ?? null)}
            </dd>
          </div>
          {tls?.storedUpload != null && (
            <div>
              <dt className="text-foreground-subtle">
                {t('system.localAccess.storedUpload', 'Stored upload')}
              </dt>
              <dd className="font-medium">
                {t('system.localAccess.storedUploadValue', 'valid to {{validTo}}, {{ca}}', {
                  validTo: new Date(tls.storedUpload.validTo).toLocaleDateString(),
                  ca: tls.storedUpload.hasCa
                    ? t('system.localAccess.storedUploadWithCa', 'with its CA')
                    : t('system.localAccess.storedUploadNoCa', 'no CA'),
                })}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-foreground-subtle">
              {t('system.localAccess.caSha256', 'CA SHA-256')}
            </dt>
            <dd className="font-mono" title={tls?.caFingerprintSha256 ?? undefined}>
              {tls?.mode === 'uploaded' && tls.caFingerprintSha256 === null ? (
                <span className="font-sans text-foreground-subtle">
                  {t(
                    'system.localAccess.issuerNotIncludedInThe',
                    'Issuer not included in the upload (not the local CA)',
                  )}
                </span>
              ) : (
                truncateFingerprint(tls?.caFingerprintSha256 ?? null)
              )}
            </dd>
          </div>
        </dl>
        {tls && tls.sans.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tls.sans.map((san) => (
              <span
                key={san}
                className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-foreground-subtle"
              >
                {san}
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <ConfirmActionButton
            label={t('system.localAccess.regenerate', 'Regenerate')}
            title={t('system.localAccess.issueANewLeaf', 'Issue a new leaf?')}
            description={t(
              'system.localAccess.issuesANewLeafUnder',
              'Issues a new leaf under the current local CA. Clients that trust the CA keep working. The HTTPS listener reloads.',
            )}
            confirmLabel={t('system.localAccess.regenerate', 'Regenerate')}
            disabled={tls?.mode === 'uploaded' || regenerate.isPending}
            action={() => regenerate.mutateAsync({})}
          />
          <Button size="sm" variant="outline" onClick={() => setUploadOpen((open) => !open)}>
            {t('system.localAccess.upload', 'Upload')}
          </Button>
          {tls?.caCertPem && (
            <Button size="sm" variant="outline" onClick={handleDownloadCa}>
              {t('system.localAccess.downloadCa', 'Download CA')}
            </Button>
          )}
          {tls?.mode === 'uploaded' && (
            <ConfirmActionButton
              label={t('system.localAccess.revertToGenerated', 'Revert to generated')}
              title={t(
                'system.localAccess.revertTitle',
                'Switch back to the generated certificate?',
              )}
              description={t(
                'system.localAccess.keepsTheUploadedPair',
                'Returns to the generated local CA. The uploaded certificate and its CA stay stored here; you can select them again.',
              )}
              confirmLabel={t('system.localAccess.revert', 'Revert')}
              disabled={revert.isPending}
              action={() => revert.mutateAsync({})}
            />
          )}
          {tls?.mode === 'generated' && tls.storedUpload != null && (
            <ConfirmActionButton
              label={t('system.localAccess.useUploaded', 'Use uploaded certificate')}
              title={t('system.localAccess.useUploadedTitle', 'Serve the stored upload again?')}
              description={t(
                'system.localAccess.useUploadedDescription',
                'The stored uploaded certificate replaces the generated one on the HTTPS listener. The generated certificate stays stored.',
              )}
              confirmLabel={t('system.localAccess.useUploaded', 'Use uploaded certificate')}
              disabled={useStored.isPending}
              action={() => useStored.mutateAsync(undefined)}
            />
          )}
        </div>
        {uploadOpen && (
          <div className="space-y-2 border-t border-border pt-3">
            <PemField
              kind="certificate"
              label={t(
                'system.localAccess.certificateOrFullChainPem',
                'Certificate or full chain (PEM)',
              )}
              value={certPem}
              onChange={setCertPem}
            />
            <PemField
              kind="privateKey"
              label={t('system.localAccess.privateKeyPem', 'Private key (PEM)')}
              value={keyPem}
              onChange={setKeyPem}
            />
            <PemField
              kind="ca"
              label={t(
                'system.localAccess.caPemRequired',
                'CA (PEM) - required unless the certificate comes from a public CA',
              )}
              value={caPem}
              onChange={setCaPem}
              rows={4}
            />
            <Button
              size="sm"
              disabled={
                !certPem.trim() ||
                !keyPem.trim() ||
                checkPem('certificate', certPem) !== null ||
                checkPem('privateKey', keyPem) !== null ||
                checkPem('ca', caPem) !== null ||
                upload.isPending
              }
              onClick={() =>
                upload.mutate({
                  certPem,
                  keyPem,
                  ...(caPem.trim() ? { caPem } : {}),
                })
              }
            >
              {t('system.localAccess.saveCertificate', 'Save certificate')}
            </Button>
            {upload.isError && (
              <p className="text-xs text-danger">
                {upload.error instanceof Error
                  ? upload.error.message
                  : t('system.localAccess.uploadFailed', 'Upload failed')}
              </p>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  )
}
