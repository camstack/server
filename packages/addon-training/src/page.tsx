/// <reference types="vite/client" />
/**
 * Training page — corpus curation (Frames), cloud jobs, and providers.
 *
 * Tabs (`?tab=`): frames (annotate), jobs (run), providers (cloud accounts).
 * Providers edit/create: `?edit=` / `?new=` (useItemFormUrl).
 * Jobs create: page header Add job → ItemFormDialog (createRequested).
 */
import './index.css'
import { useCallback, useMemo, useState } from 'react'
import {
  Button,
  mountAddonPage,
  PageShell,
  Tabs,
  TabsList,
  TabsTrigger,
  type AddonPageProps,
} from '@camstack/ui-library'
import { Plus } from 'lucide-react'
import { FramesSection } from './page/frames/FramesSection.js'
import { JobsSection } from './page/JobsSection.js'
import { ProviderSection } from './page/ProviderSection.js'
import { readTrainingTab, type TrainingTab } from './page/training-tab.js'
import { useAsync } from './page/use-async.js'
import { shouldPoll } from './page/view-model.js'
import { useT } from './i18n/index.js'

export const JOB_POLL_MS = 5_000
export type { TrainingTab }
export { readTrainingTab }

function replaceTabInUrl(tab: TrainingTab): void {
  const url = new URL(window.location.href)
  url.searchParams.set('tab', tab)
  window.history.replaceState({}, '', url.toString())
}

export default function TrainingPage({ trpc, navigate }: AddonPageProps) {
  const { t } = useT()
  const [tab, setTabState] = useState<TrainingTab>(() =>
    typeof window === 'undefined' ? 'frames' : readTrainingTab(window.location.search),
  )
  const [createRequested, setCreateRequested] = useState(false)
  const setTab = useCallback((next: TrainingTab) => {
    setTabState(next)
    setCreateRequested(false)
    replaceTabInUrl(next)
  }, [])

  const providers = useAsync(() => trpc.trainingProvider.describe.query({}), [])
  const baseModels = useAsync(() => trpc.training.listBaseModels.query({}), [])
  const collections = useAsync(() => trpc.pipelineAnalytics.listRetrainCollections.query({}), [])
  const devices = useAsync(() => trpc.deviceManager.listAll.query({ projection: 'slim' }), [])
  const jobs = useAsync(() => trpc.training.listJobs.query({}), [], {
    pollMs: JOB_POLL_MS,
    poll: shouldPoll,
  })

  const names = useMemo(
    () =>
      new Map(
        devices.state.status === 'ok' ? devices.state.data.map((d) => [d.id, d.name] as const) : [],
      ),
    [devices.state],
  )
  const cameraName = useCallback((id: number) => names.get(id) ?? `#${String(id)}`, [names])

  const depsPending =
    providers.state.status === 'pending' ||
    baseModels.state.status === 'pending' ||
    collections.state.status === 'pending'

  const depsError = (() => {
    const parts: string[] = []
    if (providers.state.status === 'error') parts.push(`providers: ${providers.state.error}`)
    if (baseModels.state.status === 'error') parts.push(`base models: ${baseModels.state.error}`)
    if (collections.state.status === 'error') parts.push(`collections: ${collections.state.error}`)
    return parts.length > 0 ? parts.join('; ') : null
  })()

  return (
    <PageShell
      title={t('page.title')}
      subtitle={t('page.subtitle')}
      actions={
        tab === 'providers' ? (
          <Button
            type="button"
            size="sm"
            data-testid="training-providers-add"
            onClick={() => setCreateRequested(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('page.addProvider')}
          </Button>
        ) : tab === 'jobs' ? (
          <Button
            type="button"
            size="sm"
            data-testid="training-jobs-add"
            onClick={() => setCreateRequested(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('page.addJob')}
          </Button>
        ) : undefined
      }
    >
      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (next === 'frames' || next === 'jobs' || next === 'providers') setTab(next)
        }}
      >
        <TabsList>
          <TabsTrigger value="frames">{t('page.tabs.frames')}</TabsTrigger>
          <TabsTrigger value="jobs">{t('page.tabs.jobs')}</TabsTrigger>
          <TabsTrigger value="providers">{t('page.tabs.providers')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'frames' ? <FramesSection /> : null}

      {tab === 'providers' ? (
        <ProviderSection
          trpc={trpc}
          navigate={navigate}
          createRequested={createRequested}
          onCreateConsumed={() => setCreateRequested(false)}
        />
      ) : null}

      {tab === 'jobs' ? (
        <JobsSection
          trpc={trpc}
          providers={providers.state.status === 'ok' ? providers.state.data : null}
          baseModels={baseModels.state.status === 'ok' ? baseModels.state.data : null}
          collections={collections.state.status === 'ok' ? collections.state.data : null}
          jobs={jobs.state}
          onJobsReload={jobs.reload}
          cameraName={cameraName}
          depsPending={depsPending}
          depsError={depsError}
          createRequested={createRequested}
          onCreateConsumed={() => setCreateRequested(false)}
        />
      ) : null}
    </PageShell>
  )
}

if (import.meta.env?.DEV && document.getElementById('root')) {
  mountAddonPage(TrainingPage, { title: 'Training' })
}
