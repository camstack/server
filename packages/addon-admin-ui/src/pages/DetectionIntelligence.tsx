/**
 * People section of Library — face-recognition identities and recent crops.
 *
 * Formerly the standalone `/detection-intelligence` page. Chrome lives on
 * `Library.tsx`; this file is the body only — two `SectionCard`s matching
 * Access / Recordings list chrome.
 */

import { SECTION_BODY, SectionCard } from '@camstack/ui-library'
import { ScanFace, UserRound } from 'lucide-react'
import { PeopleList } from '../components/detection-intelligence/PeopleList'
import { UnassignedFaces } from '../components/detection-intelligence/UnassignedFaces'
import { useFaceGalleryLiveRefresh } from '../components/detection-intelligence/use-face-gallery-live-refresh'
import { useTranslation } from 'react-i18next'

export function DetectionIntelligencePage() {
  const { t } = useTranslation()
  // Auto-refresh the gallery on face-gallery-changed events (2s debounce);
  // `listRecentFaces`'s own refetchInterval is the fallback when the live
  // channel is unavailable.
  useFaceGalleryLiveRefresh()

  return (
    <div className="space-y-3">
      <SectionCard
        headingId="library-people"
        title={t('detectionIntelligence.people', 'People')}
        icon={UserRound}
        testId="library-section-people"
      >
        <div className={`${SECTION_BODY} space-y-3`}>
          <p className="text-[11px] leading-relaxed text-foreground-subtle">
            {t(
              'detectionIntelligence.enrolledIdentitiesUsedForFace',
              'Enrolled identities used for face recognition. Open a person to rename them or remove training samples.',
            )}
          </p>
          <PeopleList />
        </div>
      </SectionCard>

      <SectionCard
        headingId="library-recent-faces"
        title={t('detectionIntelligence.recentDetectedFaces', 'Recent detected faces')}
        icon={ScanFace}
        testId="library-section-recent-faces"
      >
        <div className={`${SECTION_BODY} space-y-3`}>
          <p className="text-[11px] leading-relaxed text-foreground-subtle">
            {t(
              'detectionIntelligence.faceCropsCapturedByThe',
              'Face crops captured by the detection pipeline. Assign them to a person to build recognition training data.',
            )}
          </p>
          <UnassignedFaces />
        </div>
      </SectionCard>
    </div>
  )
}
