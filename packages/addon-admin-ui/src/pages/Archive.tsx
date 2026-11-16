/**
 * Archive — the camera-centred hub for recorded footage and captured events.
 *
 * Level 1 (this page): key numbers, storage cards, ONE camera table, activity
 * and health, and the collapsed admin Tools. A camera row opens
 * `/archive/:deviceId` (`ArchiveCameraPage`). Replaces Recordings and
 * Library → Events (planning#569).
 */
import { SectionCard } from '@camstack/ui-library'
import { Activity, Archive as ArchiveIcon, Camera, HardDrive } from 'lucide-react'
import { useEffect, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import { AdminPage } from '../components/AdminPage'
import { ArchiveActivity } from '../components/archive/ArchiveActivity'
import { ArchiveCameraTable } from '../components/archive/ArchiveCameraTable'
import { ArchiveKeyNumbers } from '../components/archive/ArchiveKeyNumbers'
import { ArchiveStorageCards } from '../components/archive/ArchiveStorageCards'
import { ArchiveTools } from '../components/archive/ArchiveTools'
import { useArchiveData } from '../components/archive/use-archive-data'

export function ArchivePage(): ReactElement {
  const { t } = useTranslation()
  const data = useArchiveData()
  const { hash } = useLocation()

  // A retired `/recordings?tab=activity|management` lands on `#activity` / `#tools`.
  useEffect(() => {
    if (hash.length > 1) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [hash])

  return (
    <AdminPage
      icon={ArchiveIcon}
      title={t('nav.archive', 'Archive')}
      subtitle={t(
        'archive.subtitle',
        'Recorded footage and captured events — what they occupy, where they are written, and how each camera is doing.',
      )}
    >
      <div className="flex flex-col gap-4">
        <ArchiveKeyNumbers data={data} />
        <SectionCard
          headingId="archive-storage"
          title={t('archive.section.storage', 'Storage')}
          icon={HardDrive}
        >
          <div className="p-3">
            <ArchiveStorageCards />
          </div>
        </SectionCard>
        <SectionCard
          headingId="archive-cameras"
          title={t('archive.section.cameras', 'Cameras')}
          icon={Camera}
        >
          <ArchiveCameraTable rows={data.rows} isLoading={data.isLoading} />
        </SectionCard>
        <div id="activity">
          <SectionCard
            headingId="archive-activity"
            title={t('archive.section.activity', 'Activity & health')}
            icon={Activity}
          >
            <div className="p-3">
              <ArchiveActivity data={data} />
            </div>
          </SectionCard>
        </div>
        <div id="tools">
          <ArchiveTools openOnMount={hash === '#tools'} />
        </div>
      </div>
    </AdminPage>
  )
}
