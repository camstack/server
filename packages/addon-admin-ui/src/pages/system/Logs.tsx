/**
 * `/system/logs` — Viewer / Destinations / Levels / Watch / Diagnostics.
 *
 * Shell is library `SectionedPage` (OSD template).
 */

import { LogStream } from '@camstack/ui-library'
import { ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AdminPage } from '../../components/AdminPage'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'
import { INTEGRATION_HUB_OWNED_PARAMS, INTEGRATION_HUB_PAGES } from '../../lib/integration-hub-url'
import { navChromeForPath } from '../../lib/nav-items'
import { LogDiagnosticsPage } from './LogDiagnostics'
import { LoggingPage } from './Logging'
import { LogLevelsPage } from './LogLevels'
import { LogWatchPage } from './LogWatch'

function LogViewerTab() {
  return (
    <AdminPage embedded>
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <LogStream
          limit={500}
          maxHeight="max-h-[calc(100vh-310px)]"
          showFilters
          showOriginFilter
          columns={{
            available: ['integration', 'device'],
            defaultVisible: ['integration', 'device'],
          }}
        />
      </div>
    </AdminPage>
  )
}

export function LogsPage() {
  const { t } = useTranslation()
  const chrome = navChromeForPath('/system/logs', { t, isAdmin: true }) ?? {
    icon: ScrollText,
    title: t('system.logs', 'Logs'),
  }

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      defaultSection="viewer"
      sectionsLabel={`${chrome.title} sections`}
      sections={[
        { id: 'viewer', label: t('admin.system.logs.viewer', 'Viewer'), content: <LogViewerTab /> },
        {
          id: INTEGRATION_HUB_PAGES.logging.tab,
          label: t('admin.system.logs.destinations', 'Destinations'),
          content: <LoggingPage />,
          ownedParams: INTEGRATION_HUB_OWNED_PARAMS,
        },
        {
          id: 'levels',
          label: t('admin.system.logs.levels', 'Levels'),
          content: <LogLevelsPage />,
        },
        {
          id: 'watch',
          label: t('admin.system.logs.watch', 'Watch'),
          content: <LogWatchPage />,
        },
        {
          id: 'diagnostics',
          label: t('admin.system.logs.diagnostics', 'Diagnostics'),
          content: <LogDiagnosticsPage />,
        },
      ]}
    />
  )
}
