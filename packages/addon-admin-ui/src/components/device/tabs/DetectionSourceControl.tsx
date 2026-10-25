/**
 * DetectionSourceControl — the first control of a camera's Detection pipeline →
 * Steps editor: where this camera's detections come from (this node's
 * pipeline, the camera's own detector, or nothing).
 *
 * Presentational: the pick and its write live in `useCameraDetectionSource`.
 * It is written at once — a single choice has no half-states — and the steps
 * below it grey out to match (`detection-source-model`). Not rendered for a
 * camera with no onboard detector: a control with one option is not shown.
 */
import type { CameraDetectionSource } from '@camstack/types'
import { SegmentedChoice, TEXT_HINT, TEXT_SECTION_LABEL } from '@camstack/ui-library'
import {
  geometryNote,
  sourceExplanation,
} from '../../pipeline/step-inspector/detection-source-model'
import { useTranslation } from 'react-i18next'

interface DetectionSourceControlProps {
  readonly source: CameraDetectionSource
  readonly geometry: 'boxed' | 'while-streaming' | 'flag-only' | 'unknown'
  readonly saving: boolean
  readonly error: string | null
  readonly onPick: (source: CameraDetectionSource) => void
}

export function DetectionSourceControl({
  source,
  geometry,
  saving,
  error,
  onPick,
}: DetectionSourceControlProps) {
  const { t } = useTranslation()
  // An onboard pick that is ALREADY stored stays selectable-looking; only a
  // fresh pick of a detector that cannot box is refused.
  const cannotBox = geometry === 'flag-only'
  const note = geometryNote(geometry)
  return (
    <section
      aria-label={t('device.detectionSourceControl.rootDetector', 'Root detector')}
      aria-busy={saving}
      className="space-y-1.5 rounded-md border border-border bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className={TEXT_SECTION_LABEL}>
          {t('device.detectionSourceControl.rootDetector', 'Root detector')}
        </h3>
        <SegmentedChoice<CameraDetectionSource>
          label={t('device.detectionSourceControl.rootDetector', 'Root detector')}
          value={source}
          onChange={(next) => {
            if (!saving && next !== source) onPick(next)
          }}
          options={[
            { value: 'pipeline', label: t('device.detectionSourceControl.thisNode', 'This node') },
            {
              value: 'onboard',
              label: t('device.detectionSourceControl.cameraOnboardAi', 'Camera onboard AI'),
              disabled: cannotBox && source !== 'onboard',
              reason: note,
            },
            { value: 'none', label: t('device.detectionSourceControl.none', 'None') },
          ]}
        />
        {saving && (
          <span className={TEXT_HINT}>{t('device.detectionSourceControl.saving', 'Saving…')}</span>
        )}
      </div>
      <p className={TEXT_HINT}>
        {sourceExplanation(source)} {t('device.detectionSourceControl.oneRoot')}
      </p>
      {note !== '' && <p className={TEXT_HINT}>{note}</p>}
      {error !== null && (
        <p role="alert" className="text-[11px] text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
