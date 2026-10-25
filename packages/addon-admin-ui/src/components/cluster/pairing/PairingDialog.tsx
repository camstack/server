/**
 * Pair an agent with this hub (D857).
 *
 * Opening the dialog starts the pairing (`beginPairing`): the hub offers the
 * mesh CA to the agent and both screens show a six-digit code. Each side types
 * the OTHER side's code — this dialog shows the hub's code to read out, and an
 * input, always empty at the start, for the code the AGENT shows. The hub's
 * code is never offered back to the input, and `confirmPairing` is sent only
 * what the operator typed.
 *
 * The agent side additionally asks for the agent's local PIN, which proves the
 * person is at the agent; this page cannot see or supply it.
 *
 * Every state is drawn from an ANSWERED `getPairing` (polled every 2 s while it
 * can still change); until the first answer the dialog says the offer is going
 * out, it does not guess (D315).
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  FormField,
  Input,
  trpc,
  useClusterTopology,
} from '@camstack/ui-library'
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  canConfirm,
  formatCountdown,
  formatEndpoint,
  isCompleteCode,
  isTerminalPairing,
  PAIRING_CODE_LENGTH,
  PHASE_HEADLINE,
  pairingPhase,
  sanitizeCodeInput,
  type PairingPhase,
  type PairingView,
} from './pairing-model'
import { useTranslation } from 'react-i18next'
import i18n from '../../../i18n/index'

export const PAIRING_POLL_MS = 2000
const TICK_MS = 1000

export interface PairingTarget {
  readonly nodeId: string
  readonly host: string
  readonly port: number
}

export interface PairingDialogProps {
  /** The agent to pair; `null` closes the dialog. */
  readonly target: PairingTarget | null
  readonly onClose: () => void
  /** Called once a pairing reaches a final state, so the list refreshes. */
  readonly onSettled: () => void
  /** Show a node on the Nodes page (the dialog closes first). */
  readonly onOpenNode: (nodeId: string) => void
}

function errorText(err: { readonly message: string }): string {
  return err.message.length > 0 ? err.message : i18n.t('pairing.agentsFoundSection.requestFailed')
}

function spacedCode(code: string): string {
  return code.length === PAIRING_CODE_LENGTH ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function PairingDialog({
  target,
  onClose,
  onSettled,
  onOpenNode,
}: PairingDialogProps): ReactNode {
  const { t } = useTranslation()
  const [pairingId, setPairingId] = useState<string | null>(null)
  const [beginError, setBeginError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const startedFor = useRef<PairingTarget | null>(null)

  const begin = trpc.agentPairing.beginPairing.useMutation()
  const confirmMutation = trpc.agentPairing.confirmPairing.useMutation()
  const rejectMutation = trpc.agentPairing.rejectPairing.useMutation()

  // Start once per opened target; reset everything when it closes.
  useEffect(() => {
    if (target === null) {
      startedFor.current = null
      setPairingId(null)
      setBeginError(null)
      setTyped('')
      setConfirmError(null)
      return
    }
    if (startedFor.current === target) return
    startedFor.current = target
    void begin
      .mutateAsync({ host: target.host, port: target.port })
      .then((view) => {
        if (startedFor.current === target) setPairingId(view.pairingId)
      })
      .catch((err: { message: string }) => {
        if (startedFor.current === target) setBeginError(errorText(err))
      })
    // `begin` is a stable mutation handle per render; the target is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const query = trpc.agentPairing.getPairing.useQuery(
    { pairingId: pairingId ?? '' },
    {
      enabled: pairingId !== null,
      refetchInterval: (q) => {
        const state = q.state.data?.state
        return state !== undefined && isTerminalPairing(state) ? false : PAIRING_POLL_MS
      },
    },
  )
  // The newest answer wins: a later poll supersedes an earlier mutation result,
  // and a further-along state never regresses to an earlier poll.
  const latest = pickLatest(confirmMutation.data ?? rejectMutation.data ?? null, query.data ?? null)
  const phase = pairingPhase({ view: latest, beginError })
  const settled = latest !== null && isTerminalPairing(latest.state)

  const settledNotified = useRef(false)
  useEffect(() => {
    if (!settled) {
      settledNotified.current = false
      return
    }
    if (settledNotified.current) return
    settledNotified.current = true
    onSettled()
  }, [settled, onSettled])

  const now = useNow(latest !== null && !settled)

  const submit = (): void => {
    if (pairingId === null || !isCompleteCode(typed)) return
    setConfirmError(null)
    confirmMutation.mutate(
      { pairingId, code: typed },
      {
        onError: (err: { message: string }) => {
          setConfirmError(errorText(err))
          setTyped('')
        },
      },
    )
  }

  const reject = (): void => {
    if (pairingId === null) {
      onClose()
      return
    }
    rejectMutation.mutate({ pairingId }, { onSettled: onClose })
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            {t('pairing.pairingDialog.title', { node: target?.nodeId ?? '' })}
          </DialogTitle>
          <DialogDescription>
            {target === null
              ? ''
              : t(
                  'pairing.pairingDialog.eachScreenShowsACode',
                  'Each screen shows a code; you type the code from the OTHER screen. Agent at {{value1}}',
                  { value1: formatEndpoint(target.host, target.port) },
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <PhaseHeadline phase={phase} />
          {phase === 'send-failed' && beginError !== null && (
            <ErrorBox
              title={t(
                'pairing.pairingDialog.couldNotStartThePairing',
                'Could not start the pairing',
              )}
              message={beginError}
            />
          )}
          {latest !== null && !settled && (
            <ActiveSteps
              view={latest}
              phase={phase}
              now={now}
              typed={typed}
              onType={(raw) => setTyped(sanitizeCodeInput(raw))}
              onSubmit={submit}
              confirmError={confirmError}
              busy={confirmMutation.isPending}
            />
          )}
          {phase === 'paired' && latest !== null && (
            <PairedResult nodeId={latest.nodeId} onOpenNode={onOpenNode} onClose={onClose} />
          )}
          {settled && phase !== 'paired' && latest?.failure != null && (
            <ErrorBox message={latest.failure} />
          )}
        </DialogBody>
        <DialogFooter>
          {settled || phase === 'send-failed' ? (
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.close', 'Close')}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={rejectMutation.isPending}
                onClick={reject}
              >
                {t('pairing.pairingDialog.reject', 'Reject')}
              </Button>
              {canConfirm(phase) && (
                <Button
                  type="button"
                  disabled={!isCompleteCode(typed) || confirmMutation.isPending}
                  onClick={submit}
                >
                  {confirmMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('common.confirm', 'Confirm')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Prefer the polled answer unless a confirm/reject answer is further along. */
function pickLatest(
  fromMutation: PairingView | null,
  polled: PairingView | null,
): PairingView | null {
  if (polled === null) return fromMutation
  if (fromMutation === null) return polled
  const rank = (v: PairingView): number =>
    (isTerminalPairing(v.state) ? 10 : v.state === 'completing' ? 5 : 0) +
    (v.hubConfirmed ? 1 : 0) +
    (v.agentConfirmed ? 1 : 0)
  return rank(fromMutation) > rank(polled) ? fromMutation : polled
}

function PhaseHeadline({ phase }: { readonly phase: PairingPhase }): ReactNode {
  const busy = phase === 'sending' || phase === 'completing'
  const done = phase === 'paired'
  const bad =
    phase === 'rejected' || phase === 'failed' || phase === 'expired' || phase === 'send-failed'
  return (
    <p
      role="status"
      className={`flex items-center gap-2 text-sm font-medium ${
        done ? 'text-success' : bad ? 'text-danger' : 'text-foreground'
      }`}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {done && <CheckCircle2 className="h-4 w-4" />}
      {bad && <XCircle className="h-4 w-4" />}
      {PHASE_HEADLINE[phase]}
    </p>
  )
}

interface ActiveStepsProps {
  readonly view: PairingView
  readonly phase: PairingPhase
  readonly now: number
  readonly typed: string
  readonly onType: (raw: string) => void
  readonly onSubmit: () => void
  readonly confirmError: string | null
  readonly busy: boolean
}

function ActiveSteps({
  view,
  phase,
  now,
  typed,
  onType,
  onSubmit,
  confirmError,
  busy,
}: ActiveStepsProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <section
        aria-label={t('pairing.pairingDialog.codeOnThisHub', 'Code on this hub')}
        className="rounded-md border border-border bg-surface p-3"
      >
        <p className="text-xs text-foreground-muted">
          {t(
            'pairing.pairingDialog.codeOnThisHubRead',
            'Code on this hub — read it out to the agent',
          )}
        </p>
        <p
          data-testid="hub-code"
          className="mt-1 font-mono text-3xl font-semibold tracking-widest text-foreground"
        >
          {spacedCode(view.code)}
        </p>
        <p className="mt-2 text-xs text-foreground-muted">
          {t(
            'pairing.pairingDialog.onTheAgentEnterThis',
            'On the agent, enter this code and the agent’s local PIN (shown on the agent’s console or log, or on its own screen).',
          )}
        </p>
      </section>

      {canConfirm(phase) ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          <FormField
            label={t('pairing.pairingDialog.codeShownOnTheAgent', 'Code shown on the agent')}
            description={t(
              'pairing.pairingDialog.typeTheSixDigitsThe',
              'Type the six digits the agent displays. Do not copy the code above.',
            )}
            {...(confirmError !== null ? { error: confirmError } : {})}
          >
            <Input
              value={typed}
              onChange={(e) => onType(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              placeholder="000000"
              maxLength={PAIRING_CODE_LENGTH}
              disabled={busy}
              aria-label={t('pairing.pairingDialog.codeShownOnTheAgent', 'Code shown on the agent')}
              className="font-mono tracking-widest"
            />
          </FormField>
        </form>
      ) : (
        <p className="text-xs text-foreground-muted">
          {phase === 'awaiting-agent'
            ? t(
                'pairing.pairingDialog.youConfirmedHereTheAgent',
                'You confirmed here. The agent still has to enter the hub code and its PIN.',
              )
            : t('pairing.pairingDialog.working', 'Working…')}
        </p>
      )}

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-muted">
        <li>
          {view.hubConfirmed
            ? t('pairing.pairingDialog.hubConfirmed', 'Hub: confirmed')
            : t('pairing.pairingDialog.hubNotConfirmed', 'Hub: not confirmed')}
        </li>
        <li>
          {view.agentConfirmed
            ? t('pairing.pairingDialog.agentConfirmed', 'Agent: confirmed')
            : t('pairing.pairingDialog.agentNotConfirmed', 'Agent: not confirmed')}
        </li>
        <li data-testid="countdown">
          {t('pairing.pairingDialog.expiresIn', {
            countdown: formatCountdown(view.expiresAt, now),
          })}
        </li>
      </ul>
    </div>
  )
}

function PairedResult({
  nodeId,
  onOpenNode,
  onClose,
}: {
  readonly nodeId: string
  readonly onOpenNode: (nodeId: string) => void
  readonly onClose: () => void
}): ReactNode {
  const { t } = useTranslation()
  const { nodes } = useClusterTopology()
  const registered = nodes?.some((n) => n.id === nodeId && n.isOnline) === true
  return (
    <div className="space-y-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm">
      <p className="flex items-center gap-2 text-success">
        <ShieldCheck className="h-4 w-4" />
        {registered
          ? t(
              'pairing.pairingDialog.joinedAndRegisteredItsCapabilities',
              '{{nodeId}} joined and registered its capabilities.',
              { nodeId },
            )
          : t(
              'pairing.pairingDialog.holdsItsCertificateWaitingFor',
              '{{nodeId}} holds its certificate. Waiting for it to connect and register its capabilities…',
              { nodeId },
            )}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!registered}
        onClick={() => {
          onClose()
          onOpenNode(nodeId)
        }}
      >
        {t('pairing.pairingDialog.openNode', 'Open node')}
      </Button>
    </div>
  )
}
