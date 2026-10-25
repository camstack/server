/**
 * Points operators from the Events feed at the Training addon page —
 * where tracks marked for training are annotated and sent to cloud jobs.
 */
import { Button, Card, TEXT_HINT } from '@camstack/ui-library'
import { GraduationCap } from 'lucide-react'
import type { JSX } from 'react'
import { useNavigate } from 'react-router-dom'

import { RETRAIN_HREF } from '../../lib/events-page-url.js'
import { useTranslation } from 'react-i18next'

export function RetrainTabCallout(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <Card
      className="flex flex-col gap-3 border-border bg-surface p-3 sm:flex-row sm:items-center sm:gap-4"
      data-testid="events-feed-retrain-cta"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <GraduationCap className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-medium text-foreground">
            {t(
              'detectionIntelligence.retrainTabCallout.trainingFromThisFeed',
              'Training from this feed',
            )}
          </p>
          <p className={`${TEXT_HINT} leading-relaxed`}>
            {t(
              'detectionIntelligence.retrainTabCallout.markATrackWithThe',
              'Mark a track with the graduation-cap control on its card. On Training you correct frames, build collections, and start cloud fine-tunes.',
            )}
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 self-start sm:self-center"
        onClick={() => navigate(RETRAIN_HREF)}
      >
        {t('detectionIntelligence.retrainTabCallout.openTraining', 'Open Training')}
      </Button>
    </Card>
  )
}
