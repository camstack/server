/**
 * Network → Local access — LAN HTTP.
 *
 * HTTP enable/port/hostname are the `local-network` addon's own
 * node settings (`local-network` capability, `node` scope). The HTTPS certificate lives under Identity → Certificates.
 */
import { Link } from 'react-router-dom'
import { AddonScopedSettingsForm, STACK_GAP, useSystem } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { useInvalidateAddonSettings } from '../../hooks/useInvalidateAddonSettings'
import { AdminPage } from '../../components/AdminPage'

export const HTTPS_CERTIFICATE_HREF = '/system/identity?tab=certificates'

export function LocalAccessPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const invalidate = useInvalidateAddonSettings()
  return (
    <AdminPage embedded>
      <div className={STACK_GAP}>
        <p className="text-xs text-foreground-subtle">
          {t(
            'system.localAccess.nativeAppsOnThisWi',
            'Native apps on this Wi-Fi use http:// and skip the private certificate. The tunnel and this admin UI stay on HTTPS.',
          )}
        </p>
        <AddonScopedSettingsForm
          trpc={system.trpcClient}
          addonId="local-network"
          cap="local-network"
          scope="node"
          nodeId="hub"
          onAfterChange={invalidate}
          title={t('system.localAccess.lanHttp', 'LAN HTTP')}
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
