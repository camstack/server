/**
 * The compact strip above the Nodes table: the two authorities behind the two
 * certificates. The local HTTPS CA signs what nodes serve (and is the file a
 * client installs to trust the hub); the cluster CA signs what nodes present
 * to the hub, and its listener state says whether any node can connect.
 */
import { Badge, Button, SettingRow, useLocalNetworkGetTlsStatus } from '@camstack/ui-library'
import { AlertTriangle, Download } from 'lucide-react'
import type { ReactNode } from 'react'

import {
  describeExpiry,
  expiryTone,
  formatDateTime,
  type HttpsNodeRow,
  type MeshInventory,
} from './certificate-model'
import { useTranslation } from 'react-i18next'

const TONE_CLASS = {
  ok: 'text-foreground-subtle',
  soon: 'text-warning',
  expired: 'text-danger',
  unknown: 'text-foreground-subtle',
} as const

export interface CaStripProps {
  readonly https: readonly HttpsNodeRow[]
  readonly mesh: MeshInventory | undefined
  readonly now: number
}

function localCaFingerprint(https: readonly HttpsNodeRow[]): string | null {
  const hub = https.find((r) => r.isHub)
  return hub?.https.kind === 'served' ? hub.https.status.caFingerprintSha256 : null
}

export function CaStrip({ https, mesh, now }: CaStripProps): ReactNode {
  const { t } = useTranslation()
  const hubTls = useLocalNetworkGetTlsStatus()
  const pem = hubTls.data?.caCertPem ?? ''
  const downloadCa = (): void => {
    if (pem === '') return
    const url = URL.createObjectURL(new Blob([pem], { type: 'application/x-pem-file' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'camstack-ca.crt'
    a.click()
    URL.revokeObjectURL(url)
  }
  const ca = mesh?.ca
  const meshValidTo = ca?.state === 'ready' ? Date.parse(ca.validTo) : null
  const listener = mesh?.listener

  return (
    <div className="space-y-1" data-testid="ca-strip">
      <SettingRow
        label={t('certificates.caStrip.localHttpsCaSha256', 'Local HTTPS CA (SHA-256)')}
        valueClassName="font-mono"
      >
        <span className="flex flex-wrap items-center gap-2">
          {localCaFingerprint(https) ?? '—'}
          {pem !== '' && (
            <Button type="button" variant="ghost" size="sm" onClick={downloadCa}>
              <Download className="h-3 w-3" aria-hidden />
              {t('certificates.caStrip.downloadCa', 'Download CA')}
            </Button>
          )}
        </span>
      </SettingRow>
      <SettingRow
        label={t('certificates.caStrip.clusterCaSha256', 'Cluster CA (SHA-256)')}
        valueClassName="font-mono"
      >
        {ca === undefined ? (
          '—'
        ) : ca.state === 'ready' ? (
          ca.fingerprintSha256
        ) : (
          <span className="text-danger">
            {t('certificates.caStrip.unavailable', { reason: ca.reason })}
          </span>
        )}
      </SettingRow>
      {ca?.state === 'ready' && (
        <SettingRow label={t('certificates.caStrip.clusterCaValidUntil', 'Cluster CA valid until')}>
          {ca.validTo}
          {meshValidTo !== null && !Number.isNaN(meshValidTo) && (
            <span className={`ml-2 text-[10px] ${TONE_CLASS[expiryTone(meshValidTo, now)]}`}>
              ({describeExpiry(meshValidTo, now)})
            </span>
          )}
        </SettingRow>
      )}
      {listener !== undefined && (
        <SettingRow label={t('certificates.caStrip.nodeListener', 'Node listener')}>
          {listener.state === 'open' && (
            <Badge variant="success">{t('certificates.caStrip.open', 'Open')}</Badge>
          )}
          {listener.state === 'not-started' && (
            <Badge variant="default">{t('certificates.caStrip.notStarted', 'Not started')}</Badge>
          )}
          {listener.state === 'closed' && (
            <span className="text-danger">
              {t('certificates.caStrip.closedSince', { when: formatDateTime(listener.since) })}{' '}
              {listener.reason}
            </span>
          )}
        </SettingRow>
      )}
      {mesh !== undefined && !mesh.registryAvailable && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            {t(
              'certificates.caStrip.theCertificateRegistryIsNot',
              'The certificate registry is not up, so the node list below is incomplete.',
            )}
          </span>
        </div>
      )}
    </div>
  )
}
