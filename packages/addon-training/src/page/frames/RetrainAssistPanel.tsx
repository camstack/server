/**
 * Pre-annotation assist — two engines, picked per run.
 *
 * - **Bigger detector (teacher).** A larger detector from the catalog of the
 *   node that runs this camera's detection, run on that node through the
 *   pipeline runner (never on the hub's event loop) on the frame copy. Its
 *   boxes arrive as `source: 'assist'` drafts with their scores, at a lower
 *   floor than production: a teacher is there to find what the camera's model
 *   missed.
 * - **AI vision.** A vision-capable LLM profile (the `llm` capability) is
 *   asked to list the objects of the chosen classes and to review every box
 *   already on the frame. Its boxes arrive as `source: 'llm'` drafts with the
 *   model's reason; its reviews flag existing boxes ("this person is a
 *   plant").
 *
 * "Both" runs the teacher first, so the AI also reviews the teacher's boxes.
 *
 * Nothing is accepted: every result is a draft or a flag (D790). A profile
 * that sends the frame outside the house is named as such, and every run that
 * uses one asks first.
 */

import type { PipelineSchema, RetrainMacroClass } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  usePipelineAnalyticsListRetrainAssistProfiles,
  usePipelineAnalyticsProposeRetrainAnnotations,
  usePipelineAnalyticsProposeRetrainAnnotationsWithLlm,
} from '@camstack/ui-library'
import type { RetrainFrame } from '@camstack/types'
import { Loader2, Wand2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { AssistDetector } from './lib/retrain-assist-defaults.js'
import {
  addDrafts,
  type EditorBoxInput,
  type EditorState,
  flagBoxes,
  flagsFromReviews,
} from './lib/retrain-editor.js'
import { TEACHER_DEFAULT_MIN_SCORE, teacherCandidates } from './lib/retrain-teacher.js'
import { useT, type TFn } from '../../i18n/index.js'
import { frameAddress } from './frame-address.js'
import type { RetrainEditorHistory } from './use-retrain-editor-history.js'

type Engine = 'teacher' | 'llm' | 'both'

const ENGINES: readonly Engine[] = ['teacher', 'llm', 'both']

/** The classes an AI run looks for by default — the detector's own. */
const DEFAULT_CLASSES: readonly RetrainMacroClass[] = ['person', 'vehicle', 'animal', 'package']
const ALL_CLASSES: readonly RetrainMacroClass[] = [
  'person',
  'vehicle',
  'animal',
  'package',
  'face',
  'plate',
]

/** The sentence for an AI refusal; an unknown reason answers itself. */
function llmRefusalText(t: TFn, reason: string): string {
  switch (reason) {
    case 'unknown-frame':
      return t('assist.refusal.unknownFrame')
    case 'unreadable-frame':
      return t('assist.refusal.unreadableFrame')
    case 'unknown-profile':
      return t('assist.refusal.unknownProfile')
    case 'profile-disabled':
      return t('assist.refusal.profileDisabled')
    case 'no-vision':
      return t('assist.refusal.noVision')
    case 'cloud-not-confirmed':
      return t('assist.refusal.cloudNotConfirmed')
    case 'llm-error':
      return t('assist.refusal.llmError')
    case 'malformed-answer':
      return t('assist.refusal.malformedAnswer')
    default:
      return reason
  }
}

interface RetrainAssistPanelProps {
  readonly frame: RetrainFrame
  readonly history: RetrainEditorHistory
  readonly detector: AssistDetector
  readonly schema: PipelineSchema | undefined
  readonly setNotice: (text: string | null) => void
}

export function RetrainAssistPanel({
  frame,
  history,
  detector,
  schema,
  setNotice,
}: RetrainAssistPanelProps) {
  const { t } = useT()
  const profiles = usePipelineAnalyticsListRetrainAssistProfiles({}, { retry: false })
  const proposeTeacher = usePipelineAnalyticsProposeRetrainAnnotations()
  const proposeLlm = usePipelineAnalyticsProposeRetrainAnnotationsWithLlm()

  const [engine, setEngine] = useState<Engine>('teacher')
  const teachers = useMemo(
    () => teacherCandidates(schema, detector.kind === 'resolved' ? detector.modelId : undefined),
    [schema, detector],
  )
  const [teacherId, setTeacherId] = useState<string | null>(null)
  const teacher = teachers.find((c) => c.modelId === teacherId) ?? teachers[0]
  const [minScore, setMinScore] = useState(TEACHER_DEFAULT_MIN_SCORE)
  const [profileId, setProfileId] = useState<string | null>(null)
  const profile = (profiles.data ?? []).find((p) => p.id === profileId) ?? profiles.data?.[0]
  const [classes, setClasses] = useState<readonly RetrainMacroClass[]>(DEFAULT_CLASSES)
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  // The editor as of the LATEST render: a run spans awaits, and the operator
  // may keep editing meanwhile — results are applied to what is on screen then.
  const editorRef = useRef(history.editor)
  editorRef.current = history.editor

  const usesTeacher = engine !== 'llm'
  const usesLlm = engine !== 'teacher'
  const teacherReady = detector.kind === 'resolved' && teacher !== undefined
  const llmReady = profile !== undefined && classes.length > 0
  const ready = (!usesTeacher || teacherReady) && (!usesLlm || llmReady)

  /** The teacher's boxes, added as drafts to what is on screen now. */
  const runTeacher = async (): Promise<string> => {
    if (detector.kind !== 'resolved' || teacher === undefined) return ''
    const result = await proposeTeacher.mutateAsync({
      ...frameAddress(frame),
      subject: { kind: 'objects', modelId: teacher.modelId, minScore },
      nodeId: detector.nodeId,
    })
    if (result.kind === 'refused') {
      return result.detail !== undefined
        ? t('assist.teacherRefusedDetail', {
            name: teacher.name,
            reason: result.reason,
            detail: result.detail,
          })
        : t('assist.teacherRefused', { name: teacher.name, reason: result.reason })
    }
    const added = addDrafts(
      editorRef.current,
      result.proposals.map(
        (p): EditorBoxInput => ({
          bbox: p.bbox,
          macroClass: p.macroClass,
          ...(p.label !== undefined ? { label: p.label } : {}),
          kind: p.kind,
          source: 'assist',
          ...(p.assistModelId !== undefined ? { assistModelId: p.assistModelId } : {}),
          ...(p.assistScore !== undefined ? { assistScore: p.assistScore } : {}),
          ...(p.origin ? { origin: p.origin } : {}),
          draft: true,
          note: t('assist.teacherNote', { model: result.modelId, node: detector.nodeId }),
        }),
      ),
    )
    // Applied synchronously from the latest state, so an AI run that follows
    // reviews these boxes under the keys they really have.
    editorRef.current = added.state
    history.setEditor(added.state)
    const fresh = result.proposals.length - added.skipped
    return added.skipped > 0
      ? t('assist.teacherResultSkipped', {
          name: teacher.name,
          count: fresh,
          skipped: added.skipped,
        })
      : t('assist.teacherResult', { name: teacher.name, count: fresh })
  }

  /** The AI's boxes and reviews, applied to what is on screen when it answers. */
  const runLlm = async (allowCloud: boolean): Promise<string> => {
    if (profile === undefined) return ''
    const sent: EditorState = editorRef.current
    const result = await proposeLlm.mutateAsync({
      ...frameAddress(frame),
      profileId: profile.id,
      classes: [...classes],
      boxes: sent.boxes.slice(0, 50).map((b) => ({
        ref: b.key,
        bbox: b.bbox,
        macroClass: b.macroClass,
        ...(b.label !== undefined && b.label !== '' ? { label: b.label } : {}),
      })),
      allowCloud,
    })
    if (result.kind === 'refused') {
      return `${llmRefusalText(t, result.reason)}${result.detail !== undefined ? ` (${result.detail})` : ''}`
    }
    const drafts = result.proposals.map(
      (p): EditorBoxInput => ({
        bbox: p.bbox,
        macroClass: p.macroClass,
        ...(p.label !== undefined ? { label: p.label } : {}),
        kind: 'subject',
        source: 'llm',
        ...(p.assistModelId !== undefined ? { assistModelId: p.assistModelId } : {}),
        ...(p.assistScore !== undefined ? { assistScore: p.assistScore } : {}),
        ...(p.origin ? { origin: p.origin } : {}),
        draft: true,
        note: t('assist.llmNote', { model: result.model, reason: p.reason }),
      }),
    )
    const flags = flagsFromReviews(result.reviews, result.model)
    const added = addDrafts(editorRef.current, drafts)
    history.setEditor((current) => flagBoxes(addDrafts(current, drafts).state, flags))
    const fresh = result.proposals.length - added.skipped
    const doubts = result.reviews.filter((r) => r.verdict !== 'confirmed').length
    const summary = [
      t('assist.llmDrafts', { count: fresh }),
      t('assist.llmQuestioned', { count: doubts }),
      ...(result.rejected > 0 ? [t('assist.llmDropped', { count: result.rejected })] : []),
    ].join(', ')
    return `${profile.name}: ${summary}.`
  }

  const run = async (allowCloud: boolean): Promise<void> => {
    setConfirming(false)
    setRunning(true)
    setNotice(null)
    try {
      const notes: string[] = []
      if (usesTeacher) notes.push(await runTeacher())
      if (usesLlm) notes.push(await runLlm(allowCloud))
      setNotice(`${notes.filter((n) => n !== '').join(' ')} ${t('assist.draftsNotSaved')}`)
    } catch (err: unknown) {
      setNotice(t('assist.failed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setRunning(false)
    }
  }

  const onRun = (): void => {
    // Every run that would send the frame outside the house asks first.
    if (usesLlm && profile?.leavesHouse === true) {
      setConfirming(true)
      return
    }
    void run(false)
  }

  return (
    <div
      className="px-3 py-2 border-b border-border space-y-2 text-[11px]"
      data-testid="retrain-assist"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-foreground">{t('assist.title')}</span>
        <Select
          className="w-36"
          aria-label={t('assist.engine')}
          value={engine}
          options={ENGINES.map((value) => ({ value, label: t(`assist.engines.${value}`) }))}
          onChange={(event) => {
            const next = ENGINES.find((value) => value === event.target.value)
            if (next !== undefined) setEngine(next)
          }}
        />
        <span className="flex-1" />
        <Button size="sm" variant="secondary" disabled={!ready || running} onClick={onRun}>
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          <span className="ml-1">{t('assist.run')}</span>
        </Button>
      </div>

      {usesTeacher &&
        (teachers.length === 0 || detector.kind !== 'resolved' ? (
          <p className="text-foreground-subtle">
            {detector.kind !== 'resolved' ? t('assist.noNode') : t('assist.noLarger')}
          </p>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              className="flex-1 min-w-40"
              aria-label={t('assist.largerDetector')}
              value={teacher?.modelId ?? ''}
              options={teachers.map((c) => ({
                value: c.modelId,
                label: t('assist.teacherOption', { name: c.name, size: Math.round(c.sizeMB) }),
              }))}
              onChange={(event) => {
                setTeacherId(event.target.value)
              }}
            />
            <Input
              className="w-20"
              aria-label={t('assist.minScore')}
              type="number"
              min={0.05}
              max={0.95}
              step={0.05}
              value={minScore}
              onChange={(event) => {
                const value = Number.parseFloat(event.target.value)
                if (Number.isFinite(value)) setMinScore(Math.min(0.95, Math.max(0.05, value)))
              }}
            />
            <span className="text-foreground-subtle">
              {t('assist.onNode', { node: detector.nodeId })}
            </span>
          </div>
        ))}

      {usesLlm &&
        ((profiles.data ?? []).length === 0 ? (
          <p className="text-foreground-subtle">
            {profiles.isError ? t('assist.profilesUnreadable') : t('assist.noProfile')}
          </p>
        ) : (
          <div className="space-y-1.5">
            <Select
              aria-label={t('assist.profile')}
              value={profile?.id ?? ''}
              options={(profiles.data ?? []).map((p) => ({
                value: p.id,
                label: `${p.name} · ${p.model} · ${p.leavesHouse ? t('assist.cloud') : t('assist.local')}`,
              }))}
              onChange={(event) => {
                setProfileId(event.target.value)
              }}
            />
            {profile?.leavesHouse === true && (
              <p className="text-warning">{t('assist.leavesHome')}</p>
            )}
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-foreground-subtle">{t('assist.lookFor')}</span>
              {ALL_CLASSES.map((c) => {
                const on = classes.includes(c)
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={on}
                    className={`rounded-full border px-2 py-0.5 ${on ? 'border-primary text-primary' : 'border-border text-foreground-muted'}`}
                    onClick={() => {
                      setClasses((current) =>
                        on ? current.filter((x) => x !== c) : [...current, c],
                      )
                    }}
                  >
                    {c}
                  </button>
                )
              })}
            </div>
          </div>
        ))}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('assist.confirm.title')}</DialogTitle>
            <DialogDescription>
              {t('assist.confirm.message', {
                source:
                  frame.origin === 'recording'
                    ? t('assist.confirm.sourceRecording')
                    : t('assist.confirm.sourceTrack'),
                profile: profile?.name ?? t('assist.confirm.defaultProfile'),
                kind: profile?.kind ?? 'cloud',
                model: profile?.model ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirming(false)
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void run(true)}>
              {t('assist.confirm.send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
