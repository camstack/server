/**
 * Archive → Overview: key numbers, storage cards, ONE camera table, activity
 * and health, and the collapsed admin Tools. A camera row opens the Cameras
 * section on that camera.
 */
import { SectionCard } from '@camstack/ui-library'
import { Activity, Camera, HardDrive } from 'lucide-react'
import { useEffect, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import { ArchiveActivity } from './ArchiveActivity'
import { ArchiveCameraTable } from './ArchiveCameraTable'
import { ArchiveKeyNumbers } from './ArchiveKeyNumbers'
import { ArchiveStorageCards } from './ArchiveStorageCards'
import { ArchiveTools } from './ArchiveTools'
import type { ArchiveData } from './use-archive-data'

export interface ArchiveOverviewProps {
  readonly data: ArchiveData
}

export function ArchiveOverview({ data }: ArchiveOverviewProps): ReactElement {
  const { t } = useTranslation()
  const { hash } = useLocation()

  // A retired `/recordings?tab=activity|management` lands on `#activity` / `#tools`.
  useEffect(() => {
    if (hash.length > 1) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [hash])

  return (
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
  )
}
