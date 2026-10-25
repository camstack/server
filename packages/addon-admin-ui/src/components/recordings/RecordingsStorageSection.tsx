/**
 * RecordingsStorageSection — the Recordings page's "Recordings" tab body.
 *
 * Everything whose subject is FOOTAGE, and nothing else:
 *   - the footage footprint (`StorageSection`);
 *   - where footage is written (`ClusterRecordingTab`).
 *
 * Storage migration is on Management — it moves more than footage.
 */
import { ClusterRecordingTab } from '../pipeline/tabs/ClusterRecordingTab'
import { StorageSection } from './StorageSection'
import { useTranslation } from 'react-i18next'

export function RecordingsStorageSection() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {t('recordings.recordingsStorageSection.footageOnDisk', 'Footage on disk')}
        </h2>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'recordings.recordingsStorageSection.whatRecordedFootageOccupiesPer',
            'What recorded footage occupies, per camera and per volume, with prune-by-policy and delete-all-footage.',
          )}
        </p>
        <div className="mt-3">
          <StorageSection />
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {t(
            'recordings.recordingsStorageSection.recordingNodeFolders',
            'Recording node & folders',
          )}
        </h2>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'recordings.recordingsStorageSection.theSingleNodeThatRecords',
            'The single node that records and serves playback, and the storage locations footage is written to.',
          )}
        </p>
        <div className="mt-3">
          <ClusterRecordingTab />
        </div>
      </div>
    </div>
  )
}
