/**
 * Archive overview → Tools (collapsed, admin): storage migration, cleanup and
 * reconcile-from-disk. The destructive ones keep their own confirmations.
 */
import { CollapsibleCard } from '@camstack/ui-library'
import { Wrench } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { PruneEventsByAge } from './PruneEventsByAge'
import { CleanupSection } from '../recordings/CleanupSection'
import { DiskReconcileSection } from '../recordings/DiskReconcileSection'
import { ExportsSection } from '../recordings/ExportsSection'
import { StorageMigrationSection } from '../recordings/migration/StorageMigrationSection'

export function ArchiveTools({ openOnMount }: { readonly openOnMount: boolean }): ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(openOnMount)
  useEffect(() => {
    if (openOnMount) setExpanded(true)
  }, [openOnMount])
  return (
    <CollapsibleCard
      expanded={expanded}
      onExpandedChange={setExpanded}
      header={
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Wrench className="h-3.5 w-3.5" />
          {t('archive.tools.title', 'Tools')}
          <span className="text-[11px] font-normal text-foreground-subtle">
            {t(
              'archive.tools.subtitle',
              'Storage migration, prune events, cleanup, all exports, reconcile from disk',
            )}
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-6" data-testid="archive-tools">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {t('archive.tools.migration', 'Move storage')}
          </h3>
          <p className="text-[11px] text-foreground-subtle">
            {t(
              'archive.tools.migrationHint',
              'Copy footage, low-res footage or event media to a new location, verify, then repoint the default. Applies to every camera.',
            )}
          </p>
          <StorageMigrationSection />
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {t('archive.tools.pruneEvents', 'Prune old events')}
          </h3>
          <PruneEventsByAge />
        </section>
        <CleanupSection />
        <section className="flex flex-col gap-2" data-testid="archive-all-exports">
          <h3 className="text-sm font-semibold text-foreground">
            {t('archive.tools.allExports', 'All exports')}
          </h3>
          <p className="text-[11px] text-foreground-subtle">
            {t(
              'archive.tools.allExportsHint',
              'Every export across all cameras, including cameras that were removed.',
            )}
          </p>
          <ExportsSection />
        </section>
        <DiskReconcileSection />
      </div>
    </CollapsibleCard>
  )
}
