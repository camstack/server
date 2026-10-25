/**
 * Library — People / Vehicles / Events / Scenes (Detection).
 *
 * Shell is library `SectionedPage` (OSD template): sidebar title/icon + section
 * Tabs. Events' inner Feed/Debug strip uses `?section=` via nested
 * `sectionsOnly` SectionedPage.
 */
import { Library as LibraryIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AdminSectionedPage } from '../components/AdminSectionedPage'

import { navChromeForPath } from '../lib/nav-items'
import { DetectionIntelligencePage } from './DetectionIntelligence'
import { EventsPage } from './Events'
import { PlatesPage } from './Plates'
import { ScenesPage } from './Scenes'

export function LibraryPage() {
  const { t } = useTranslation()
  const chrome = navChromeForPath('/library', { t, isAdmin: true }) ?? {
    icon: LibraryIcon,
    title: t('nav.library', 'Library'),
  }

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      subtitle={t(
        'library.peopleVehiclesCapturedEventsAnd',
        'People, vehicles, captured events and scenes — what detection has recognised.',
      )}
      defaultSection="people"
      sectionsLabel={`${chrome.title} sections`}
      sections={[
        {
          id: 'people',
          label: t('library.people', 'People'),
          content: <DetectionIntelligencePage />,
        },
        { id: 'vehicles', label: t('library.vehicles', 'Vehicles'), content: <PlatesPage /> },
        {
          id: 'events',
          label: t('library.events', 'Events'),
          content: <EventsPage />,
          ownedParams: ['section'],
        },
        { id: 'scenes', label: t('library.scenes', 'Scenes'), content: <ScenesPage /> },
      ]}
    />
  )
}
