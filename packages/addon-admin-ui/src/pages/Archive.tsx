/**
 * Archive — the camera-centred hub for recorded footage and captured events
 * (planning#569). Two sections on `?section=`:
 *
 * - `overview` — key numbers, storage, the camera table, activity, tools;
 * - `cameras` — one camera's workspace (`&camera=<id>`), picked in its header.
 *
 * Exports are listed in Library; the Archive only creates them (shift-drag on
 * the Review timeline).
 */
import { Archive as ArchiveIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { AdminSectionedPage } from '../components/AdminSectionedPage'
import { ArchiveCameraSection } from '../components/archive/ArchiveCameraSection'
import { ArchiveOverview } from '../components/archive/ArchiveOverview'
import { CAMERA_PARAM, SECTION_PARAM, VIEW_PARAM } from '../components/archive/archive-redirects'
import { useArchiveData } from '../components/archive/use-archive-data'

export function ArchivePage(): ReactElement {
  const { t } = useTranslation()
  const data = useArchiveData()
  return (
    <AdminSectionedPage
      icon={ArchiveIcon}
      title={t('nav.archive', 'Archive')}
      subtitle={t(
        'archive.subtitle',
        'Recorded footage and captured events — what they occupy, where they are written, and how each camera is doing.',
      )}
      paramName={SECTION_PARAM}
      defaultSection="overview"
      sectionsLabel={t('archive.sections', 'Archive sections')}
      sections={[
        {
          id: 'overview',
          label: t('archive.section.overview', 'Overview'),
          content: <ArchiveOverview data={data} />,
        },
        {
          id: 'cameras',
          label: t('archive.section.cameras', 'Cameras'),
          ownedParams: [CAMERA_PARAM, VIEW_PARAM],
          content: <ArchiveCameraSection data={data} />,
        },
      ]}
    />
  )
}
