/**
 * The keychain at a glance: state, where the master key comes from, its
 * fingerprint, whether a recovery copy exists — and the two key actions.
 *
 * Long values (the key path) are truncated with the full text as a tooltip
 * and a copy button, so a deep path never widens the card. Warnings about any
 * of these facts live in the page's notice region, not here.
 */
import type { KeychainKeySource, KeychainStatus } from '@camstack/types'
import { Badge, Button, CopyButton, SECTION_BODY, SectionCard } from '@camstack/ui-library'
import { KeyRound, Lock, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatWhen } from './format'
import { Truncated } from './Truncated'
import { useTranslation } from 'react-i18next'

const SOURCE_LABEL: Record<KeychainKeySource['kind'], string> = {
  'config-file': 'Key file (config.yaml)',
  'previous-config-file': 'Previous key file',
  platform: 'OS keychain',
  'default-file': 'Default key file (data volume)',
}

/** How many fingerprint characters the card shows; the rest is in the tooltip. */
const FINGERPRINT_SHORT = 8

export interface KeychainStatusCardProps {
  readonly status: KeychainStatus
  readonly busy: boolean
  readonly onDownload: () => void
  readonly onRotate: () => void
  readonly onPurge: () => void
}

export function KeychainStatusCard({
  status,
  busy,
  onDownload,
  onRotate,
  onPurge,
}: KeychainStatusCardProps) {
  const { t } = useTranslation()
  const locked = status.keychain.state === 'locked'
  const source = status.keySource ?? status.configuredSource
  return (
    <SectionCard
      headingId="keychain-status"
      title={t('secrets.keychainStatusCard.keychain', 'Keychain')}
      icon={KeyRound}
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {status.retiredWraps > 0 && (
            <Button size="sm" variant="ghost" disabled={busy || locked} onClick={onPurge}>
              {t('secrets.keychainStatusCard.purge', { count: status.retiredWraps })}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy || locked} onClick={onRotate}>
            {t('secrets.keychainStatusCard.rotateKey', 'Rotate key')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || locked} onClick={onDownload}>
            {t('secrets.keychainStatusCard.downloadRecoveryKey', 'Download recovery key')}
          </Button>
        </div>
      }
    >
      <dl
        className={`${SECTION_BODY} grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4`}
      >
        <Fact label={t('secrets.keychainStatusCard.state', 'State')}>
          {locked ? (
            <Badge variant="danger" className="gap-1">
              <Lock className="h-3 w-3" aria-hidden />
              {t('secrets.keychainStatusCard.locked', 'Locked')}
            </Badge>
          ) : (
            <Badge variant="success" className="gap-1">
              <ShieldCheck className="h-3 w-3" aria-hidden />
              {t('secrets.keychainStatusCard.unlocked', 'Unlocked')}
            </Badge>
          )}
          <span className="ml-2 text-foreground-subtle">
            {t('common.stored', { count: status.secretCount })}
          </span>
        </Fact>
        <Fact label={t('secrets.keychainStatusCard.keySource', 'Key source')}>
          <span className="block">{SOURCE_LABEL[source.kind]}</span>
          {source.path !== undefined && <Truncated value={source.path} srLabel="key path" />}
        </Fact>
        <Fact label={t('secrets.keychainStatusCard.fingerprint', 'Fingerprint')}>
          {status.fingerprint === null ? (
            <span className="text-foreground-subtle">—</span>
          ) : (
            <span className="inline-flex items-center gap-0.5">
              <span className="font-mono" title={status.fingerprint}>
                {status.fingerprint.slice(0, FINGERPRINT_SHORT)}
              </span>
              <CopyButton value={status.fingerprint} srLabel="fingerprint" />
            </span>
          )}
        </Fact>
        <Fact label={t('secrets.keychainStatusCard.recoveryKey', 'Recovery key')}>
          {status.recoveryKeyDownloadedAt === null ? (
            <Badge variant="warning">{t('secrets.keychainStatusCard.notTaken', 'Not taken')}</Badge>
          ) : (
            <span>
              {t('secrets.keychainStatusCard.taken', {
                when: formatWhen(status.recoveryKeyDownloadedAt),
              })}
            </span>
          )}
        </Fact>
      </dl>
    </SectionCard>
  )
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0 text-xs">
      <dt className="text-foreground-subtle">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-foreground">{children}</dd>
    </div>
  )
}
