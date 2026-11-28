/**
 * The pairing-code tab of the Add device modal (D1011) for a Matter fabric: a device that is
 * already on the network, shared by another controller. The operator pastes the manual code or
 * the `MT:` payload. Progress is the broker's commissioning phase. The modal
 * owns the dialog; this is the body and footer of its tab.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  DialogBody,
  DialogFooter,
  ErrorBox,
  Input,
  Label,
  useBrokerGetState,
  useBrokerInstances,
  useBrokerPublish,
} from '@dominevo/ui-library'
import { Loader2 } from 'lucide-react'

/** The broker kind this dialog commissions into (this dialog IS the Matter flow). */
const MATTER_BROKER_KIND = 'matter'

/**
 * The addon that owns the Matter `broker` provider. `broker` is a collection cap: a call without
 * an addon id goes to whichever broker addon the hub picks (mqtt-broker once answered a
 * commissioning with "not supported").
 */
const MATTER_BROKER_ADDON_ID = 'matter-broker'

const PHASES = ['discovering', 'pase', 'commissioning', 'done'] as const

type Phase = (typeof PHASES)[number] | 'failed' | 'idle'

interface CommissionView {
  readonly phase: Phase
  readonly failure: string | null
  readonly message: string | null
}

interface FailureCopy {
  readonly key: string
  readonly defaultValue: string
}

interface MatterPairingPanelProps {
  /** The Matter fabric this integration is linked to; null when the link is not set. */
  readonly brokerId: string | null
  readonly onClose: () => void
  readonly onCommissioned: () => void
}

function isCommissionView(value: unknown): value is CommissionView {
  if (typeof value !== 'object' || value === null) return false
  if (!('phase' in value) || typeof value.phase !== 'string') return false
  return true
}

function failureCopy(failure: string | null, message: string | null): FailureCopy {
  if (failure === 'code-expired' || message?.includes('matter-commission:code-expired')) {
    return {
      key: 'integrations.addMatter.failure.expired',
      defaultValue: 'The pairing code expired. Share the device again and paste the new code.',
    }
  }
  if (failure === 'device-not-found' || message?.includes('matter-commission:device-not-found')) {
    return {
      key: 'integrations.addMatter.failure.notFound',
      defaultValue: 'No Matter device with that code was found on the network.',
    }
  }
  if (failure === 'wrong-code' || message?.includes('matter-commission:wrong-code')) {
    return {
      key: 'integrations.addMatter.failure.wrongCode',
      defaultValue: 'The pairing code was rejected.',
    }
  }
  if (failure === 'invalid-code' || message?.includes('invalid pairing code')) {
    return {
      key: 'integrations.addMatter.failure.invalid',
      defaultValue: 'Enter an 11-digit or 21-digit manual code, or a code that starts with MT:.',
    }
  }
  return {
    key: 'integrations.addMatter.failure.unknown',
    defaultValue: message ?? 'Commissioning failed.',
  }
}

export function MatterPairingPanel({
  brokerId,
  onClose,
  onCommissioned,
}: MatterPairingPanelProps): ReactElement {
  const { t } = useTranslation()
  // The fabric is the integration's own (its `brokerId`): never picked, never created here.
  const brokers = useBrokerInstances({ kind: MATTER_BROKER_KIND })
  const own = brokers.data?.find((b) => b.id === brokerId) ?? null
  const ownDown = own !== null && !own.usable
  const publish = useBrokerPublish()
  const [code, setCode] = useState('')
  const [view, setView] = useState<CommissionView>({
    phase: 'idle',
    failure: null,
    message: null,
  })
  const busy =
    view.phase === 'discovering' || view.phase === 'pase' || view.phase === 'commissioning'
  const progress = useBrokerGetState(
    {
      addonId: MATTER_BROKER_ADDON_ID,
      brokerId: brokerId ?? '',
      key: 'commission',
    },
    { enabled: brokerId !== null && busy, refetchInterval: busy ? 400 : false },
  )

  useEffect(() => {
    if (!busy) return
    if (!isCommissionView(progress.data)) return
    if (progress.data.phase === 'idle') return
    setView({
      phase: progress.data.phase,
      failure: typeof progress.data.failure === 'string' ? progress.data.failure : null,
      message: typeof progress.data.message === 'string' ? progress.data.message : null,
    })
  }, [busy, progress.data])

  const submit = (): void => {
    if (brokerId === null) return
    setView({ phase: 'discovering', failure: null, message: null })
    publish.mutate(
      {
        addonId: MATTER_BROKER_ADDON_ID,
        brokerId,
        target: { action: 'commissionNode' },
        payload: { pairingCode: code.trim() },
      },
      {
        onSuccess: () => setView({ phase: 'done', failure: null, message: null }),
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : 'Commissioning failed.'
          const failure = message.includes('matter-commission:')
            ? (message.split('matter-commission:')[1]?.split(':')[0] ?? 'unknown')
            : message.includes('invalid pairing code')
              ? 'invalid-code'
              : 'unknown'
          setView({ phase: 'failed', failure, message })
        },
      },
    )
  }

  const failedCopy = view.phase === 'failed' ? failureCopy(view.failure, view.message) : null
  const failure =
    failedCopy === null ? null : t(failedCopy.key, { defaultValue: failedCopy.defaultValue })
  const noBroker = brokerId === null

  return (
    <>
      <DialogBody className="space-y-4">
        <p className="text-xs text-foreground-subtle">
          {t('integrations.addMatter.help', {
            defaultValue: 'Paste the 11-digit pairing code or the MT: QR code.',
          })}
        </p>
        {noBroker && (
          <ErrorBox
            message={t('integrations.addMatter.noFabric', {
              defaultValue:
                'This integration is not linked to a Matter fabric. Edit it to link one.',
            })}
          />
        )}
        {own !== null && ownDown && (
          <ErrorBox
            message={t('integrations.addMatter.fabricDown', {
              defaultValue:
                'The Matter fabric is not running ({{state}}). It starts again with the Matter addon; try again in a moment.',
              state: own.stateLabel ?? own.state,
            })}
          />
        )}
        {!noBroker && (
          <div className="space-y-1.5">
            <Label htmlFor="matter-pairing-code">
              {t('integrations.addMatter.code', {
                defaultValue: 'Pairing code',
              })}
            </Label>
            <Input
              id="matter-pairing-code"
              value={code}
              autoComplete="off"
              spellCheck={false}
              placeholder="34970112332"
              disabled={busy || view.phase === 'done'}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
        )}
        {view.phase !== 'idle' && (
          <ol
            className="space-y-1"
            aria-label={t('integrations.addMatter.progress', {
              defaultValue: 'Commissioning progress',
            })}
          >
            {PHASES.map((phase) => {
              const current = view.phase === phase
              return (
                <li
                  key={phase}
                  className={`text-xs ${current ? 'text-foreground font-medium' : 'text-foreground-subtle'}`}
                >
                  {current && busy ? (
                    <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                  ) : null}
                  {t(`integrations.addMatter.phase.${phase}`, {
                    defaultValue:
                      phase === 'discovering'
                        ? 'Discovering'
                        : phase === 'pase'
                          ? 'PASE'
                          : phase === 'commissioning'
                            ? 'Commissioning'
                            : 'Done',
                  })}
                </li>
              )
            })}
          </ol>
        )}
        {failure !== null && <ErrorBox message={failure} />}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.close', { defaultValue: 'Close' })}
        </Button>
        {view.phase === 'done' ? (
          <Button size="sm" onClick={onCommissioned}>
            {t('integrations.adoptDevices', {
              defaultValue: 'Adopt devices',
            })}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || noBroker || own === null || ownDown || code.trim().length === 0}
            onClick={submit}
          >
            {busy
              ? t('integrations.addMatter.working', {
                  defaultValue: 'Adding…',
                })
              : t('integrations.addMatter.submit', {
                  defaultValue: 'Add device',
                })}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}
