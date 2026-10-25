/**
 * Vehicles section of Library — plate identities and recent OCR reads.
 *
 * Formerly the standalone `/plates` page. Chrome lives on `Library.tsx`; this
 * file is the body only — two `SectionCard`s matching the People section.
 */

import { SECTION_BODY, SectionCard } from '@camstack/ui-library'
import { Car, ScanLine } from 'lucide-react'
import { RecentPlates } from '../components/detection-intelligence/RecentPlates'
import { VehiclesList } from '../components/detection-intelligence/VehiclesList'
import { usePlateGalleryLiveRefresh } from '../components/detection-intelligence/use-plate-gallery-live-refresh'
import { useTranslation } from 'react-i18next'

export function PlatesPage() {
  const { t } = useTranslation()
  // Auto-refresh the gallery on plate-gallery-changed events (2s debounce);
  // `listPlates`'s own refetchInterval is the fallback when the live channel
  // is unavailable.
  usePlateGalleryLiveRefresh()

  return (
    <div className="space-y-3">
      <SectionCard
        headingId="library-vehicles"
        title={t('plates.vehicles', 'Vehicles')}
        icon={Car}
        testId="library-section-vehicles"
      >
        <div className={`${SECTION_BODY} space-y-3`}>
          <p className="text-[11px] leading-relaxed text-foreground-subtle">
            {t(
              'plates.enrolledVehicleIdentitiesUsedFor',
              'Enrolled vehicle identities used for plate recognition. Open a vehicle to rename it or remove plate samples.',
            )}
          </p>
          <VehiclesList />
        </div>
      </SectionCard>

      <SectionCard
        headingId="library-recent-plates"
        title={t('plates.recentRecognizedPlates', 'Recent recognized plates')}
        icon={ScanLine}
        testId="library-section-recent-plates"
      >
        <div className={`${SECTION_BODY} space-y-3`}>
          <p className="text-[11px] leading-relaxed text-foreground-subtle">
            {t(
              'plates.licensePlatesReadByThe',
              'License plates read by the detection pipeline. Assign them to a vehicle, correct the OCR text, or delete.',
            )}
          </p>
          <RecentPlates />
        </div>
      </SectionCard>
    </div>
  )
}
