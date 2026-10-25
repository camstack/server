/**
 * Jobs tab — DataTable list + ItemFormDialog create (Providers pattern).
 * State filter on the list; no inline New job form.
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import type {
  RetrainCollection,
  TrainingBaseModel,
  TrainingJob,
  TrainingProviderDescriptor,
} from '@camstack/types'
import {
  ErrorBox,
  ItemFormDialog,
  SECTION_BODY,
  SectionCard,
  type AddonPageProps,
} from '@camstack/ui-library'
import { Cloud } from 'lucide-react'
import { useT } from '../i18n/index.js'
import { JobsTable } from './JobsTable.js'
import { NewJobSection } from './NewJobSection.js'
import { SectionState } from './SectionState.js'
import type { AsyncState } from './use-async.js'

export interface JobsSectionProps {
  readonly trpc: AddonPageProps['trpc']
  readonly providers: readonly TrainingProviderDescriptor[] | null
  readonly baseModels: readonly TrainingBaseModel[] | null
  readonly collections: readonly RetrainCollection[] | null
  readonly jobs: AsyncState<readonly TrainingJob[]>
  readonly onJobsReload: () => void
  readonly cameraName: (id: number) => string
  /** True while any of providers / baseModels / collections is still unanswered. */
  readonly depsPending: boolean
  /** Settled fetch failure for those deps — never folded into pending (D315). */
  readonly depsError: string | null
  /** Page header Add job — open create dialog when deps are ready. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

function collectionNameOf(
  collections: readonly RetrainCollection[] | null,
): (id: string) => string {
  const map = new Map((collections ?? []).map((c) => [c.id, c.name] as const))
  return (id) => map.get(id) ?? id
}

export function JobsSection({
  trpc,
  providers,
  baseModels,
  collections,
  jobs,
  onJobsReload,
  cameraName,
  depsPending,
  depsError,
  createRequested = false,
  onCreateConsumed,
}: JobsSectionProps): JSX.Element {
  const { t } = useT()
  const collectionName = useMemo(() => collectionNameOf(collections), [collections])
  const [createOpen, setCreateOpen] = useState(false)
  const [formKey, setFormKey] = useState(0)

  const depsReady =
    !depsPending &&
    depsError === null &&
    providers !== null &&
    baseModels !== null &&
    collections !== null

  useEffect(() => {
    if (!createRequested) return
    if (!depsReady) return
    setFormKey((k) => k + 1)
    setCreateOpen(true)
    onCreateConsumed?.()
  }, [createRequested, depsReady, onCreateConsumed])

  const closeCreate = (): void => setCreateOpen(false)

  return (
    <div className="space-y-4" data-testid="training-jobs">
      {depsPending ? (
        <p className="text-sm text-foreground-muted">{t('jobsSection.loadingDeps')}</p>
      ) : null}
      {depsError !== null ? (
        <ErrorBox title={t('jobsSection.couldNotLoadSetup')} message={depsError} />
      ) : null}

      <SectionCard headingId="training-jobs-heading" title={t('jobsSection.title')}>
        <div className={`${SECTION_BODY} space-y-3`}>
          <SectionState state={jobs} empty={t('jobs.emptyNone')}>
            {(list) => (
              <JobsTable
                jobs={list}
                trpc={trpc}
                onChanged={onJobsReload}
                cameraName={cameraName}
                collectionName={collectionName}
              />
            )}
          </SectionState>
        </div>
      </SectionCard>

      {depsReady ? (
        <ItemFormDialog
          open={createOpen}
          onClose={closeCreate}
          title={t('page.addJob')}
          icon={Cloud}
          width="xl"
          testId="job-create-dialog"
        >
          <NewJobSection
            key={formKey}
            trpc={trpc}
            providers={providers}
            baseModels={baseModels}
            collections={collections}
            cameraName={cameraName}
            onStarted={onJobsReload}
            onClose={closeCreate}
          />
        </ItemFormDialog>
      ) : null}
    </div>
  )
}
