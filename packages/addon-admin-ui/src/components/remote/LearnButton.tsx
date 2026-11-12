/**
 * "Learn" for an infrared source: the operator points a remote at the chosen
 * transmitter and presses a key, and the code lands in the draft. Mounted only
 * once a transmitter is known; shown only when that transmitter says it can
 * learn (`getInfo.learn`). A native code is kept as such, otherwise the
 * measured timings are kept as a raw code.
 */
import type { IrLearnResult } from '@camstack/types'
import { Button, useIrTransmitterGetInfo, useIrTransmitterLearn } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SourceDraft } from './remote-config-model'

/** What a learned result changes in the draft. */
export function draftPatchOfLearned(result: IrLearnResult): Partial<SourceDraft> {
  if (result.native !== null) {
    return {
      encoding: 'native',
      nativeFormat: result.native.format,
      code: result.native.code,
      carrierKhz: '',
    }
  }
  return {
    encoding: 'raw',
    code: result.timings.join(', '),
    carrierKhz: result.carrierHz === null ? '' : String(result.carrierHz / 1000),
  }
}

export interface LearnButtonProps {
  readonly transmitterId: number
  readonly onLearned: (patch: Partial<SourceDraft>) => void
}

export function LearnButton({ transmitterId, onLearned }: LearnButtonProps): ReactNode {
  const { t } = useTranslation()
  const info = useIrTransmitterGetInfo({ deviceId: transmitterId })
  const learn = useIrTransmitterLearn()
  const [error, setError] = useState<string | null>(null)
  if (info.data?.learn !== true) return null
  const run = (): void => {
    setError(null)
    learn
      .mutateAsync({ deviceId: transmitterId })
      .then((result) => onLearned(draftPatchOfLearned(result)))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : t('remote.sources.learn.failed'))
      })
  }
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="secondary"
        size="sm"
        className="self-start"
        disabled={learn.isPending}
        onClick={run}
        data-testid="source-learn"
      >
        {learn.isPending ? t('remote.sources.learn.pending') : t('remote.sources.learn.button')}
      </Button>
      <p className="text-xs text-foreground-muted">{t('remote.sources.learn.hint')}</p>
      {error !== null && (
        <p className="text-xs text-danger" role="alert" data-testid="source-learn-error">
          {error}
        </p>
      )}
    </div>
  )
}
