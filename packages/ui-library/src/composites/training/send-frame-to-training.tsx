/**
 * <SendFrameToTrainingButton> — "Send frame to training" from a recording
 * playhead.
 *
 * The frame a detector most needs to learn from is often one where it saw
 * NOTHING — no event, no track, nothing to mark. From the recording, the
 * operator stops on that moment and sends it: the hub re-decodes the native
 * frame at the playhead instant and adds it to a named training collection,
 * where the Retrain page annotates it like any other frame.
 *
 * Draws NOTHING for a session that cannot curate training data: the
 * collection list is admin-only, and a button that 403s is worse than no
 * button. It is disabled, with the reason, while there is no playhead.
 */
import { GraduationCap, Loader2 } from 'lucide-react'
import { useState, type JSX } from 'react'
import {
  usePipelineAnalyticsAddRetrainFrameFromRecording,
  usePipelineAnalyticsListRetrainCollections,
} from '../../generated/system-hooks'
import { useUiText } from '../../contexts/ui-text'
import { Button } from '../../primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import { TrainingCollectionPicker } from './training-collection-picker'
import { trainingRefusalText } from './training-refusal-text'

export interface SendFrameToTrainingButtonProps {
  readonly deviceId: number
  /** The playhead instant, or `null` while nothing is being played back. */
  readonly epochMs: number | null
}

type Outcome =
  | { readonly kind: 'added'; readonly reused: boolean; readonly collection: string }
  | { readonly kind: 'refused'; readonly text: string }

export function SendFrameToTrainingButton({
  deviceId,
  epochMs,
}: SendFrameToTrainingButtonProps): JSX.Element | null {
  const t = useUiText()
  const collections = usePipelineAnalyticsListRetrainCollections({}, { retry: false })
  const send = usePipelineAnalyticsAddRetrainFrameFromRecording()
  const [open, setOpen] = useState(false)
  const [collectionId, setCollectionId] = useState<string | null>(null)
  // The instant is frozen when the dialog opens: playback keeps moving.
  const [instant, setInstant] = useState<number | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  if (collections.isError) return null

  const onSend = async (): Promise<void> => {
    if (collectionId === null || instant === null) return
    const result = await send.mutateAsync({ collectionId, deviceId, epochMs: instant })
    const name =
      collections.data?.find((c) => c.id === collectionId)?.name ??
      t('uiLibrary.sendFrameToTraining.theCollection', 'the collection')
    setOutcome(
      result.kind === 'added'
        ? { kind: 'added', reused: result.reused, collection: name }
        : { kind: 'refused', text: trainingRefusalText(result.reason, result.detail) },
    )
    if (result.kind === 'added') await collections.refetch()
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="send-frame-to-training"
        disabled={epochMs === null}
        title={
          epochMs === null
            ? t(
                'uiLibrary.sendFrameToTraining.playFirst',
                'Play back a recording first — the frame at the playhead is the one sent',
              )
            : t(
                'uiLibrary.sendFrameToTraining.addFrame',
                'Add the frame at the playhead to a training collection',
              )
        }
        onClick={() => {
          setInstant(epochMs)
          setOutcome(null)
          setOpen(true)
        }}
      >
        <GraduationCap className="h-3.5 w-3.5" />
        {t('uiLibrary.sendFrameToTraining.button', 'Send frame to training')}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !send.isPending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('uiLibrary.sendFrameToTraining.title', 'Send this frame to training')}
            </DialogTitle>
            <DialogDescription>
              {instant !== null
                ? t(
                    'uiLibrary.sendFrameToTraining.description',
                    "The camera's frame at {{time}} is taken from the recording at full resolution and added to the collection. Annotate it on the Retrain page — including what the model missed.",
                    { time: new Date(instant).toLocaleString() },
                  )
                : ''}
            </DialogDescription>
          </DialogHeader>
          <TrainingCollectionPicker value={collectionId} onChange={setCollectionId} />
          {outcome !== null && (
            <p
              className={`mt-2 text-xs ${outcome.kind === 'added' ? 'text-success' : 'text-danger'}`}
              role="status"
            >
              {outcome.kind === 'added'
                ? outcome.reused
                  ? t(
                      'uiLibrary.sendFrameToTraining.reused',
                      'That moment was already in the dataset; it is now in {{collection}}.',
                      { collection: outcome.collection },
                    )
                  : t('uiLibrary.sendFrameToTraining.added', 'Added to {{collection}}.', {
                      collection: outcome.collection,
                    })
                : outcome.text}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={send.isPending}
              onClick={() => {
                setOpen(false)
              }}
            >
              {outcome?.kind === 'added'
                ? t('uiLibrary.sendFrameToTraining.done', 'Done')
                : t('uiLibrary.sendFrameToTraining.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={collectionId === null || send.isPending || outcome?.kind === 'added'}
              onClick={() => void onSend()}
            >
              {send.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('uiLibrary.sendFrameToTraining.send', 'Send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
