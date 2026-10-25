/**
 * Identity & Access — Users / Tokens & sessions / Certificates / Authentication.
 *
 * Shell is library `SectionedPage` (OSD template): sidebar title/icon + section
 * Tabs. Retired `?tab=api-keys|linked-sessions` redirect into Tokens & sessions.
 * Create for Tokens lives on the page header (Notifications pattern).
 */
import { Button } from '@camstack/ui-library'
import { Lock, Smartphone } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useSearchParams } from 'react-router-dom'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'

import {
  INTEGRATION_HUB_OWNED_PARAMS,
  INTEGRATION_HUB_PAGES,
  integrationHubHref,
} from '../../lib/integration-hub-url'
import { navChromeForPath } from '../../lib/nav-items'
import {
  ACCESS_CREATE_URL_KEYS,
  ACCESS_KINDS,
  AccessPage,
  accessHeaderActions,
  useAccessHeaderCreate,
} from './Access'
import { AuthenticationPage } from './Authentication'
import { CertificatesPage } from './Certificates'
import { UsersPage } from './Users'
import i18n from '../../i18n/index'

/** Retired tab id → the Tokens & sessions kind it now opens. */
export const RETIRED_IDENTITY_TABS: Readonly<Record<string, string>> = {
  'api-keys': ACCESS_KINDS.tokens,
  'linked-sessions': ACCESS_KINDS.linkedApps,
}

/** The `?tab=` value of the Certificates section. */
export const CERTIFICATES_TAB = 'certificates'

function pairDeviceAction(onPair: () => void) {
  return (
    <Button size="sm" type="button" data-testid="certificates-pair-device" onClick={onPair}>
      <Smartphone className="h-3.5 w-3.5" aria-hidden />
      {i18n.t('systemPage.identity.pairADevice', 'Pair a device')}
    </Button>
  )
}

export function IdentityPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const create = useAccessHeaderCreate()
  const [pairOpen, setPairOpen] = useState(false)
  const retired = RETIRED_IDENTITY_TABS[searchParams.get('tab') ?? '']
  if (retired !== undefined) {
    return <Navigate to={integrationHubHref('access', { integration: retired })} replace />
  }

  const chrome = navChromeForPath('/system/identity', { t, isAdmin: true }) ?? {
    icon: Lock,
    title: t('system.identity', 'Identity & Access'),
  }

  const tab = searchParams.get('tab') ?? 'users'
  const integration = searchParams.get('integration')
  const headerActions =
    tab === INTEGRATION_HUB_PAGES.access.tab
      ? accessHeaderActions(integration, create.requestCreate)
      : tab === CERTIFICATES_TAB
        ? pairDeviceAction(() => setPairOpen(true))
        : undefined

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      defaultSection="users"
      sectionsLabel={`${chrome.title} sections`}
      actions={headerActions}
      sections={[
        { id: 'users', label: t('systemPage.identity.users', 'Users'), content: <UsersPage /> },
        {
          id: INTEGRATION_HUB_PAGES.access.tab,
          label: t('systemPage.identity.tokensSessions', 'Tokens & sessions'),
          // The hub's params plus the create-dialog keys this tab also owns.
          ownedParams: INTEGRATION_HUB_OWNED_PARAMS.concat([
            ACCESS_CREATE_URL_KEYS.token,
            ACCESS_CREATE_URL_KEYS.scoped,
            ACCESS_CREATE_URL_KEYS.admin,
          ]),
          content: (
            <AccessPage
              createRequested={create.createRequested}
              onCreateConsumed={create.clearCreate}
            />
          ),
        },
        {
          id: CERTIFICATES_TAB,
          label: t('systemPage.identity.certificates', 'Certificates'),
          content: <CertificatesPage pairOpen={pairOpen} onPairClose={() => setPairOpen(false)} />,
        },
        {
          id: INTEGRATION_HUB_PAGES.authentication.tab,
          label: t('systemPage.identity.authentication', 'Authentication'),
          content: <AuthenticationPage />,
          ownedParams: INTEGRATION_HUB_OWNED_PARAMS,
        },
      ]}
    />
  )
}
