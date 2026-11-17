/**
 * Library — People / Vehicles / Scenes (Detection).
 *
 * Shell is library `SectionedPage` (OSD template): sidebar title/icon + section
 * Tabs. Events moved to the Archive; exports are listed here (the Archive only
 * creates them, from the Review timeline).
 */
import { Library as LibraryIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AdminSectionedPage } from '../components/AdminSectionedPage'

import { ExportsSection } from '../components/recordings/ExportsSection'
import { EXPORT_CAMERA_PARAM } from '../components/recordings/export-camera-filter'
import { navChromeForPath } from '../lib/nav-items'
import { DetectionIntelligencePage } from './DetectionIntelligence'
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
        'library.subtitleWithExports',
        'People, vehicles, scenes and exports — what detection has recognised, and the clips you rendered.',
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
        { id: 'scenes', label: t('library.scenes', 'Scenes'), content: <ScenesPage /> },
        {
          id: 'exports',
          label: t('library.exports', 'Exports'),
          content: <ExportsSection />,
          // `?camera=` narrows Exports only; another section never inherits it.
          ownedParams: [EXPORT_CAMERA_PARAM],
        },
      ]}
    />
  )
}
