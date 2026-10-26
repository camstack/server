/**
 * Add a Matter device that is already on the network (Home Assistant "Share
 * device", or the Aqara app). The operator pastes the manual code or the
 * `MT:` payload. Progress is the broker's commissioning phase.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  Input,
  Label,
  useBrokerGetState,
  useBrokerList,
  useBrokerPublish,
} from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'

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

interface AddMatterDeviceDialogProps {
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

export function AddMatterDeviceDialog({
  onClose,
  onCommissioned,
}: AddMatterDeviceDialogProps): ReactElement {
  const { t } = useTranslation()
  const brokers = useBrokerList({ kind: 'matter' })
  const brokerId = brokers.data?.[0]?.id ?? null
  const publish = useBrokerPublish()
  const [code, setCode] = useState('')
  const [view, setView] = useState<CommissionView>({ phase: 'idle', failure: null, message: null })
  const busy =
    view.phase === 'discovering' || view.phase === 'pase' || view.phase === 'commissioning'
  const progress = useBrokerGetState(
    { brokerId: brokerId ?? '', key: 'commission' },
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
  const brokersReady = brokers.isSuccess === true || brokers.data !== undefined
  const noBroker = brokersReady && brokerId === null

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            {t('integrations.addMatter.title', { defaultValue: 'Add Matter device' })}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-xs text-foreground-subtle">
            {t('integrations.addMatter.help', {
              defaultValue:
                'In Home Assistant, open the device and choose Share device. Paste the numeric code or the MT: code here. The device stays in Home Assistant.',
            })}
          </p>
          {noBroker ? (
            <ErrorBox
              message={t('integrations.addMatter.noBroker', {
                defaultValue: 'Create the Matter fabric from this integration’s settings first.',
              })}
            />
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="matter-pairing-code">
                {t('integrations.addMatter.code', { defaultValue: 'Pairing code' })}
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
              {t('integrations.adoptDevices', { defaultValue: 'Adopt devices' })}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy || noBroker || code.trim().length === 0}
              onClick={submit}
            >
              {busy
                ? t('integrations.addMatter.working', { defaultValue: 'Adding…' })
                : t('integrations.addMatter.submit', { defaultValue: 'Add device' })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
