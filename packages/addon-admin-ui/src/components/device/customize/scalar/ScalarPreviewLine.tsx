/** The dialog's live preview line. A failed read is "?", never 0. */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ScalarPreview } from './scalar-preview'
import { isScalarPreviewFailureReason, scalarPreviewFailureI18nKey } from './scalar-reason'

export interface ScalarPreviewLineProps {
  readonly preview: ScalarPreview | { readonly kind: 'pending' }
}

export function ScalarPreviewLine({ preview }: ScalarPreviewLineProps): ReactNode {
  const { t } = useTranslation()
  return (
    <p className="text-[11px] text-foreground" data-testid="scalar-preview">
      <span className="text-foreground-muted">{t('customize.scalar.preview')} </span>
      {preview.kind === 'pending' && <span>…</span>}
      {preview.kind === 'value' && <span>{preview.text}</span>}
      {preview.kind === 'dwell' && (
        <span>
          {t('customize.scalar.previewDwell', {
            value: preview.sourceText,
            level: preview.active
              ? t('customize.scalar.thresholdActive')
              : t('customize.scalar.thresholdClear'),
            countdown: t(
              preview.active ? 'customize.scalar.runningIn' : 'customize.scalar.stopsAfter',
              { seconds: Math.round(preview.countdownMs / 1000) },
            ),
          })}
        </span>
      )}
      {preview.kind === 'failed' && (
        <span
          title={
            isScalarPreviewFailureReason(preview.reason)
              ? t(scalarPreviewFailureI18nKey(preview.reason))
              : preview.reason
          }
          className="text-warning"
        >
          ?
        </span>
      )}
    </p>
  )
}
