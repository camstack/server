/**
 * Network → Local access — LAN HTTP.
 *
 * HTTP enable/port/hostname are the `local-network` addon's own
 * `globalSettingsSchema()` — the same settings surface every other addon
 * uses. The HTTPS certificate lives under Identity → Certificates.
 */
import { Link } from 'react-router-dom'
import { STACK_GAP } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { AdminPage } from '../../components/AdminPage'
import { NodeAddonsSettingsPanel } from '../../components/settings/NodeAddonsSettingsPanel'

export const HTTPS_CERTIFICATE_HREF = '/system/identity?tab=certificates'

export function LocalAccessPage() {
  const { t } = useTranslation()
  return (
    <AdminPage embedded>
      <div className={STACK_GAP}>
        <NodeAddonsSettingsPanel
          nodeId="hub"
          addonIds={['local-network']}
          level="global"
          title={t('system.localAccess.lanHttp', 'LAN HTTP')}
          description={t(
            'system.localAccess.nativeAppsOnThisWi',
            'Native apps on this Wi-Fi use http:// and skip the private certificate. The tunnel and this admin UI stay on HTTPS.',
          )}
        />
        <p className="text-xs text-foreground-subtle" data-testid="https-certificate-hint">
          {t(
            'system.localAccess.certificateMoved',
            'The HTTPS certificate and the local CA are managed under',
          )}{' '}
          <Link className="underline" to={HTTPS_CERTIFICATE_HREF}>
            {t('system.localAccess.certificateMovedLink', 'Identity → Certificates')}
          </Link>
          .
        </p>
      </div>
    </AdminPage>
  )
}
