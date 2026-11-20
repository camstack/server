/**
 * `/system/logs` — Viewer / Events / Destinations / Levels / Diagnostics.
 *
 * Shell is library `SectionedPage` (OSD template).
 */

import { LogStream } from '@camstack/ui-library'
import { ScrollText } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AdminPage } from '../../components/AdminPage'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'
import { INTEGRATION_HUB_OWNED_PARAMS, INTEGRATION_HUB_PAGES } from '../../lib/integration-hub-url'
import { navChromeForPath } from '../../lib/nav-items'
import { LogDiagnosticsPage } from './LogDiagnostics'
import { EVENTS_CATEGORIES_PARAM, LogEventsTab } from './LogEvents'
import { LoggingPage } from './Logging'
import { LogLevelsPage } from './LogLevels'

function LogViewerTab() {
  // `/system/logs?deviceId=<id>` — the Archive camera page's Health link.
  const [searchParams] = useSearchParams()
  const rawDeviceId = searchParams.get('deviceId')
  const deviceId = rawDeviceId === null ? undefined : Number(rawDeviceId)
  return (
    <AdminPage embedded>
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <LogStream
          deviceId={deviceId !== undefined && Number.isFinite(deviceId) ? deviceId : undefined}
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
        {
          id: 'viewer',
          label: t('admin.system.logs.viewer', 'Viewer'),
          content: <LogViewerTab />,
        },
        {
          id: 'events',
          label: t('admin.system.logs.events', 'Events'),
          content: <LogEventsTab />,
          ownedParams: [EVENTS_CATEGORIES_PARAM],
        },
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
          id: 'diagnostics',
          label: t('admin.system.logs.diagnostics', 'Diagnostics'),
          content: <LogDiagnosticsPage />,
        },
      ]}
    />
  )
}
