/**
 * RecordingsManagementSection — Recordings page → "Management" tab.
 *
 * Operator maintenance for stored footage and analytics:
 *   - `CleanupSection` — one pass over leftover analytics (DB + files) and
 *     ghost footage rows, with optional debug-media sweep and live progress.
 *   - `DiskReconcileSection` — disk-wins fleet walk (separate: destructive,
 *     fleet-wide, not part of cleanup).
 *   - `StorageMigrationSection` — coordinated move of recordings / low-res /
 *     event media. Not footage-only, so it does not live on the Recordings tab.
 *
 * Single-domain prune / delete / retention live on Recordings, Events and Cameras.
 */
import { CleanupSection } from './CleanupSection'
import { DiskReconcileSection } from './DiskReconcileSection'
import { StorageMigrationSection } from './migration/StorageMigrationSection'
import { useTranslation } from 'react-i18next'

export function RecordingsManagementSection() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <CleanupSection />
      <DiskReconcileSection />
      <section>
        <h2 className="text-sm font-semibold text-foreground">
          {t('recordings.recordingsManagementSection.moveStorage', 'Move storage')}
        </h2>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'recordings.recordingsManagementSection.copyRecordingsLowResRecordings',
            'Copy recordings, low-res recordings or event media to a new location, verify, then repoint the default. Applies to every camera.',
          )}
        </p>
        <div className="mt-3">
          <StorageMigrationSection />
        </div>
      </section>
    </div>
  )
}
