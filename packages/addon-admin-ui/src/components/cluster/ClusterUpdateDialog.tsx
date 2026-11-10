import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { ClusterUpdateJob, ClusterUpdateOptions, ClusterUpdatePlan } from '@camstack/types'
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import {
  CLUSTER_UPDATE_POLL_MS,
  classifyJobRead,
  dialogMode,
  nextFollowing,
  optionsFromChoices,
  resumeJob,
  type ClusterUpdateView,
  type JobRead,
} from '../../lib/cluster-update-view'
import { ClusterUpdateSteps } from './ClusterUpdateSteps'
import {
  clusterUpdateClock,
  useHubClusterUpdateClient,
  type ClusterUpdateClient,
  type ClusterUpdateClock,
} from './cluster-update-client'

export interface ClusterUpdateDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

type PlanState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly plan: ClusterUpdatePlan }
  | { readonly kind: 'error'; readonly message: string }

interface SessionProps extends ClusterUpdateDialogProps {
  readonly client: ClusterUpdateClient
  readonly clock: ClusterUpdateClock
}

/** Page entry: the hub client, the real clock. */
export function ClusterUpdateDialog(props: ClusterUpdateDialogProps): JSX.Element {
  const client = useHubClusterUpdateClient()
  return <ClusterUpdateSession {...props} client={client} clock={clusterUpdateClock} />
}

/**
 * Preview, confirm, and the step list. Also the resume strip: a running job
 * found on load is shown while the dialog is closed. Specs pass `client` and
 * `clock`; the page uses {@link ClusterUpdateDialog}.
 */
export function ClusterUpdateSession({
  open,
  onOpenChange,
  client,
  clock,
}: SessionProps): JSX.Element {
  const { t } = useTranslation()
  const [skipBackup, setSkipBackup] = useState(false)
  const [skipAddons, setSkipAddons] = useState(false)
  const [startedJobId, setStartedJobId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startMessage, setStartMessage] = useState<string | null>(null)
  const [view, setView] = useState<ClusterUpdateView>({ kind: 'idle' })
  const [planState, setPlanState] = useState<PlanState>({ kind: 'idle' })

  const options = useMemo(
    () => optionsFromChoices({ skipBackup, skipAddons }),
    [skipBackup, skipAddons],
  )
  const mode = dialogMode(view, startedJobId)
  const shown = jobOnScreen(view)
  const resume = resumeJob(view)

  useJobPoll(client, clock, startedJobId, setView)
  usePreview(client, open, mode, options, setPlanState)

  const start = useCallback(async (): Promise<void> => {
    setStarting(true)
    setStartMessage(null)
    try {
      const result = await client.start(options)
      if (!result.accepted || result.jobId === null) {
        setStartMessage(result.message)
        return
      }
      setStartedJobId(result.jobId)
    } catch (err) {
      setStartMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }, [client, options])

  const close = useCallback((): void => {
    if (view.kind !== 'job' || view.job.state !== 'running') setStartedJobId(null)
    onOpenChange(false)
  }, [onOpenChange, view])

  return (
    <>
      {!open && resume !== null && (
        <ClusterUpdateSteps
          steps={resume.steps}
          restarting={view.kind === 'restarting'}
          targetVersion={resume.targetVersion}
          skippedOffline={resume.skippedOffline}
        />
      )}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          width="lg"
          placement="sheet-on-mobile"
          scroll="body"
          aria-label={t('clusterUpdate.title', 'Update the cluster')}
        >
          <DialogHeader>
            <DialogTitle>{t('clusterUpdate.title', 'Update the cluster')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {mode === 'progress' ? (
              <ProgressBody view={view} shown={shown} />
            ) : (
              <PreviewBody
                planState={planState}
                skipBackup={skipBackup}
                skipAddons={skipAddons}
                startMessage={startMessage}
                onSkipBackup={setSkipBackup}
                onSkipAddons={setSkipAddons}
              />
            )}
          </DialogBody>
          <DialogFooter>
            {mode === 'preview' ? (
              <>
                <Button type="button" variant="ghost" onClick={close}>
                  {t('clusterUpdate.cancel', 'Cancel')}
                </Button>
                <Button
                  type="button"
                  disabled={
                    starting || planState.kind !== 'ready' || planState.plan.blocker !== null
                  }
                  onClick={() => void start()}
                >
                  {t('clusterUpdate.start', 'Start update')}
                </Button>
              </>
            ) : (
              <Button type="button" variant="ghost" onClick={close}>
                {t('clusterUpdate.close', 'Close')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function jobOnScreen(view: ClusterUpdateView): ClusterUpdateJob | null {
  if (view.kind === 'job') return view.job
  if (view.kind === 'restarting') return view.last
  return null
}

function useJobPoll(
  client: ClusterUpdateClient,
  clock: ClusterUpdateClock,
  startedJobId: string | null,
  setView: (view: ClusterUpdateView) => void,
): void {
  useEffect(() => {
    let cancelled = false
    let cancelLater: (() => void) | undefined
    let following = startedJobId !== null
    let last: ClusterUpdateJob | null = null

    const tick = async (): Promise<void> => {
      const read = await readJob(client, startedJobId ?? undefined)
      if (cancelled) return
      const next = classifyJobRead(read, following || last?.state === 'running', last)
      if (next.kind === 'job') last = next.job
      following = nextFollowing(following || last?.state === 'running', next)
      setView(next)
      if (!following || cancelled) return
      cancelLater = clock.later(CLUSTER_UPDATE_POLL_MS, () => void tick())
    }

    void tick()
    return () => {
      cancelled = true
      cancelLater?.()
    }
  }, [client, clock, startedJobId, setView])
}

async function readJob(client: ClusterUpdateClient, jobId: string | undefined): Promise<JobRead> {
  try {
    return { ok: true, job: await client.readJob(jobId) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

function usePreview(
  client: ClusterUpdateClient,
  open: boolean,
  mode: 'preview' | 'progress',
  options: ClusterUpdateOptions,
  setPlanState: (state: PlanState) => void,
): void {
  useEffect(() => {
    if (!open || mode !== 'preview') return
    let cancelled = false
    setPlanState({ kind: 'loading' })
    void client.preview(options).then(
      (plan) => {
        if (!cancelled) setPlanState({ kind: 'ready', plan })
      },
      (err: unknown) => {
        if (!cancelled) {
          setPlanState({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [client, open, mode, options, setPlanState])
}

interface ProgressBodyProps {
  readonly view: ClusterUpdateView
  readonly shown: ClusterUpdateJob | null
}

function ProgressBody({ view, shown }: ProgressBodyProps): JSX.Element {
  const { t } = useTranslation()
  if (shown === null) {
    return (
      <p role="status" className="text-xs text-warning">
        {t('clusterUpdate.restarting', 'The hub is restarting. Progress resumes when it answers.')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {shown.state === 'succeeded' && (
        <p role="status" className="text-xs text-success">
          {t('clusterUpdate.succeeded', 'Cluster update finished.')}
        </p>
      )}
      {shown.state === 'failed' && (
        <p role="alert" className="text-xs text-danger">
          {t('clusterUpdate.failed', {
            defaultValue: 'Stopped at {{where}}.',
            where: shown.stoppedAt ?? shown.reason ?? '',
          })}
        </p>
      )}
      <ClusterUpdateSteps
        steps={shown.steps}
        restarting={view.kind === 'restarting'}
        targetVersion={shown.targetVersion}
        skippedOffline={shown.skippedOffline}
      />
    </div>
  )
}

interface PreviewBodyProps {
  readonly planState: PlanState
  readonly skipBackup: boolean
  readonly skipAddons: boolean
  readonly startMessage: string | null
  readonly onSkipBackup: (value: boolean) => void
  readonly onSkipAddons: (value: boolean) => void
}

function PreviewBody({
  planState,
  skipBackup,
  skipAddons,
  startMessage,
  onSkipBackup,
  onSkipAddons,
}: PreviewBodyProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-foreground-muted">
        {t(
          'clusterUpdate.previewBody',
          'Backup, then the hub, then each online agent, then the addons. This page keeps the progress while the hub restarts.',
        )}
      </p>
      {planState.kind === 'loading' && (
        <p role="status" className="text-xs text-foreground-subtle">
          {t('clusterUpdate.loadingPlan', 'Reading what this update would do…')}
        </p>
      )}
      {planState.kind === 'error' && (
        <p role="alert" className="text-xs text-danger">
          {t('clusterUpdate.planFailed', {
            defaultValue: 'Could not read the plan: {{message}}',
            message: planState.message,
          })}
        </p>
      )}
      {planState.kind === 'ready' && (
        <ReadyPlan
          plan={planState.plan}
          skipBackup={skipBackup}
          skipAddons={skipAddons}
          onSkipBackup={onSkipBackup}
          onSkipAddons={onSkipAddons}
        />
      )}
      {startMessage !== null && (
        <p role="alert" className="text-xs text-danger">
          {startMessage}
        </p>
      )}
    </div>
  )
}

interface ReadyPlanProps {
  readonly plan: ClusterUpdatePlan
  readonly skipBackup: boolean
  readonly skipAddons: boolean
  readonly onSkipBackup: (value: boolean) => void
  readonly onSkipAddons: (value: boolean) => void
}

function ReadyPlan({
  plan,
  skipBackup,
  skipAddons,
  onSkipBackup,
  onSkipAddons,
}: ReadyPlanProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      {plan.blocker !== null && (
        <p role="alert" data-blocker={plan.blocker} className="text-xs text-warning">
          {t(`clusterUpdate.blocker.${plan.blocker}`)}
          {plan.blockerDetail !== null && plan.blockerDetail !== '' ? ` ${plan.blockerDetail}` : ''}
        </p>
      )}
      <ClusterUpdateSteps
        steps={plan.steps}
        restarting={false}
        targetVersion={plan.targetVersion}
        skippedOffline={plan.skippedOffline}
      />
      <label className="flex items-center gap-2 text-xs text-foreground">
        <Checkbox checked={skipBackup} onChange={(event) => onSkipBackup(event.target.checked)} />
        {t('clusterUpdate.skipBackup', 'Skip the backup')}
      </label>
      <label className="flex items-center gap-2 text-xs text-foreground">
        <Checkbox checked={skipAddons} onChange={(event) => onSkipAddons(event.target.checked)} />
        {t('clusterUpdate.skipAddons', 'Skip addon updates')}
      </label>
    </div>
  )
}
