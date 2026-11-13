/**
 * The `source_select` key of a remote layout (planning#460): a widget, not a
 * command. It shows the source the remote assumes is on (else "Sources"); a tap
 * opens a picker of the declared sources — Channels (number and name) and
 * Inputs (sequences and infrared codes) — and a pick runs `remote.selectSource` through
 * `sendMediaCommand`. A remote that declares no source draws NOTHING here.
 */
import type { RemoteLayoutButton, RemoteSource, RemoteRefusalReason } from '@camstack/types'
import { Tv } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { useRemoteSendMediaCommand } from '../../generated/system-hooks'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import type { RemoteGridPlacement } from './RemoteGrid'
import { shapeClass, toneClass } from './remote-look'

const REFUSAL_FALLBACK: Readonly<Record<RemoteRefusalReason, string>> = {
  'no-remote': 'This device has no remote configured.',
  'unbound-role': 'That button has no saved command.',
  'action-failed': 'The command failed. {{detail}}',
  'unknown-source': 'No declared source has that name.',
  'unbound-step': 'A step of this source is not bound: {{detail}}',
  'undeclared-channel': 'No source declares that channel number.',
  'press-timeout': 'The press never finished and was given up: {{detail}}',
  'no-transmitter': 'This remote has no infrared transmitter.',
}

export interface SourceSelectKeyProps {
  readonly deviceId: number
  readonly button: RemoteLayoutButton
  /** The declared sources; none = the key is not drawn. */
  readonly sources: readonly RemoteSource[]
  /** The source the remote assumes is on (`getAssumedStatus.source`), empty when unknown. */
  readonly current: string
  readonly placement: RemoteGridPlacement
}

export function SourceSelectKey({
  deviceId,
  button,
  sources,
  current,
  placement,
}: SourceSelectKeyProps): ReactNode {
  const t = useUiText()
  const send = useRemoteSendMediaCommand()
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (sources.length === 0) return null
  const label = current === '' ? t('remote.sourceSelect.label', 'Sources') : current
  const channels = sources.filter((s) => s.kind === 'digits')
  const inputs = sources.filter((s) => s.kind !== 'digits')

  const pick = async (source: RemoteSource): Promise<void> => {
    setFailure(null)
    try {
      const result = await send.mutateAsync({
        deviceId,
        command: 'selectSource',
        source: source.name,
        repeat: 1,
      })
      if (result.status === 'refused') {
        setFailure(
          t(`remote.test.refused.${result.reason}`, REFUSAL_FALLBACK[result.reason], {
            detail: result.detail ?? '',
          }),
        )
        return
      }
      if (result.status === 'not-routed') {
        setFailure(t('remote.sourceSelect.notRouted', 'This remote cannot select a source.'))
        return
      }
      setOpen(false)
    } catch (err: unknown) {
      setFailure(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        aria-label={label}
        title={label}
        data-testid={`remote-grid-button-${button.id}`}
        data-widget="source_select"
        className={cn(
          'z-10 h-full min-w-0 overflow-hidden border border-border px-2',
          shapeClass(button.shape),
          toneClass(button.tone),
        )}
        // ui-check-ok: computed grid placement of a button
        style={placement}
        onClick={() => {
          setFailure(null)
          setOpen(true)
        }}
      >
        <Tv className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate text-xs">{label}</span>
      </Button>
      {open && (
        <Dialog open onOpenChange={(next) => !next && setOpen(false)}>
          <DialogContent width="sm" placement="sheet-on-mobile" scroll="body">
            <DialogHeader>
              <DialogTitle>{t('remote.sourceSelect.title', 'Select source')}</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-3" data-testid="source-picker">
              <SourceGroup
                title={t('remote.sourceSelect.channels', 'Channels')}
                sources={channels}
                current={current}
                busy={send.isPending}
                onPick={(s) => void pick(s)}
              />
              <SourceGroup
                title={t('remote.sourceSelect.inputs', 'Inputs')}
                sources={inputs}
                current={current}
                busy={send.isPending}
                onPick={(s) => void pick(s)}
              />
              {failure !== null && (
                <p role="alert" className="text-xs text-danger" data-testid="source-picker-failure">
                  {failure}
                </p>
              )}
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

interface GroupProps {
  readonly title: string
  readonly sources: readonly RemoteSource[]
  readonly current: string
  readonly busy: boolean
  readonly onPick: (source: RemoteSource) => void
}

function SourceGroup({ title, sources, current, busy, onPick }: GroupProps): ReactNode {
  if (sources.length === 0) return null
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-foreground-muted">{title}</h3>
      <ul className="space-y-1">
        {sources.map((source) => (
          <li key={source.id}>
            <Button
              type="button"
              variant={source.name === current ? 'secondary' : 'ghost'}
              size="sm"
              disabled={busy}
              className="w-full justify-start gap-2"
              data-testid={`source-pick-${source.id}`}
              onClick={() => onPick(source)}
            >
              {source.kind === 'digits' && (
                <span className="w-10 shrink-0 text-right tabular-nums text-foreground-muted">
                  {source.number}
                </span>
              )}
              <span className="min-w-0 truncate">{source.name}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
