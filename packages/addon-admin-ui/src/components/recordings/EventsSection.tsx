/**
 * EventsSection — the Recordings page's "Events" tab body.
 *
 * Everything whose subject is the durable event store, and nothing else:
 *   - rows + media per camera, prune, delete (`EventsManagementSection`);
 *   - where event crops are written, and which node post-processes
 *     (`ClusterEventsTab`).
 *
 * Footage node + recording folders stay on the Recordings tab.
 */
import { ClusterEventsTab } from '../pipeline/tabs/ClusterEventsTab'
import { EventsManagementSection } from './EventsManagementSection'
import { useTranslation } from 'react-i18next'

export function EventsSection() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {t('recordings.eventsSection.eventStore', 'Event store')}
        </h2>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'recordings.eventsSection.whatTheDurableEventStore',
            'What the durable event store occupies, per camera, with fleet-wide prune-by-age and delete-all-events.',
          )}
        </p>
        <div className="mt-3">
          <EventsManagementSection />
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {t(
            'recordings.eventsSection.postProcessingNodeFolders',
            'Post-processing node & folders',
          )}
        </h2>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'recordings.eventsSection.theSingleNodeThatWrites',
            'The single node that writes event crops, and the storage location they land in.',
          )}
        </p>
        <div className="mt-3">
          <ClusterEventsTab />
        </div>
      </div>
    </div>
  )
}
