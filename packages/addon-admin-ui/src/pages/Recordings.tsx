/**
 * Recordings — footage / events / cameras / export / activity / management.
 *
 * Shell is library `SectionedPage` (OSD template). Tab ids are the deep-link
 * contract (`storage` stays the id for the tab labelled "Recordings").
 */
import { Film } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AdminSectionedPage } from '../components/AdminSectionedPage'

import { navChromeForPath } from '../lib/nav-items'
import { ActivitySection } from '../components/recordings/ActivitySection'
import { CameraRecordingSettingsSection } from '../components/recordings/CameraRecordingSettingsSection'
import { EventsSection } from '../components/recordings/EventsSection'
import { ExportsSection } from '../components/recordings/ExportsSection'
import { RecordingsManagementSection } from '../components/recordings/RecordingsManagementSection'
import { RecordingsStorageSection } from '../components/recordings/RecordingsStorageSection'

export function RecordingsPage() {
  const { t } = useTranslation()
  const chrome = navChromeForPath('/recordings', { t, isAdmin: true }) ?? {
    icon: Film,
    title: t('nav.recordings', 'Recordings'),
  }

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      subtitle={t(
        'recordings.recordedFootageAndTheDurable',
        'Recorded footage and the durable event store — what each occupies, where it is written, and the operations that move or reconcile both.',
      )}
      defaultSection="storage"
      sectionsLabel={`${chrome.title} sections`}
      sections={[
        {
          id: 'storage',
          label: t('recordings.recordings', 'Recordings'),
          content: <RecordingsStorageSection />,
        },
        { id: 'events', label: t('recordings.events', 'Events'), content: <EventsSection /> },
        {
          id: 'cameras',
          label: t('recordings.cameras', 'Cameras'),
          content: <CameraRecordingSettingsSection />,
        },
        { id: 'exports', label: t('recordings.export', 'Export'), content: <ExportsSection /> },
        {
          id: 'activity',
          label: t('recordings.activity', 'Activity'),
          content: <ActivitySection />,
        },
        {
          id: 'management',
          label: t('recordings.management', 'Management'),
          content: <RecordingsManagementSection />,
        },
      ]}
    />
  )
}
