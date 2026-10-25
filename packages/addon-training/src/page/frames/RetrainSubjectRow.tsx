/**
 * One subject in the list — a single line until the operator wants to edit it.
 *
 * Collapsed (≈ 36 px): colour chip (the box's stroke), review badge, class,
 * label, source icon, and the two actions that are always one click — accept a
 * draft, delete. Selecting the row (or its box on the canvas) opens the edit
 * panel under it: class, label (with the corpus vocabulary as suggestions),
 * sub-label, the model-error switch and where the box came from.
 *
 * **Three tiers, three controls.** `macroClass` is a closed dropdown; `label`
 * and `subLabel` are free text. That asymmetry is the whole design: the macro
 * class is what the exported detector predicts, so a typo there is a new class
 * with one example in it, while the label is exactly the vocabulary the page
 * exists to teach and constraining it would make the page useless — it is
 * SUGGESTED from the corpus, never required to match. Typing a macro class into
 * the label is refused with the sentence that explains the tiers, because once
 * `person` exists in both tiers "every person box" stops being answerable.
 *
 * Typing is coalesced: focus opens one undo step, blur closes it, so Ctrl+Z
 * undoes a label, not a letter.
 */

import type { RetrainMacroClass } from '@camstack/types'
import {
  Button,
  Input,
  RetrainReviewBadge,
  Select,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@camstack/ui-library'
import { Ban, Check, Info, Trash2 } from 'lucide-react'
import { useEffect, useRef, type JSX } from 'react'
import { boxLook } from './lib/retrain-box-look.js'
import type { EditorBox, EditorBoxPatch } from './lib/retrain-editor.js'
import type { Hover } from './lib/retrain-hover.js'
import { type BoxDiff, fallbackKind } from './lib/retrain-live-review.js'
import { suggestLabels, type VocabularyEntry } from './lib/retrain-vocabulary.js'
import { originalClassText } from './lib/retrain-original-class.js'
import { translate, useT, type TFn } from '../../i18n/index.js'
import { RetrainSourceIcon } from './RetrainSourceIcon.js'

/**
 * Mirrors `RetrainMacroClassSchema`. A closed set on purpose — and typed AS the
 * cap's own union, so adding a class server-side and forgetting this dropdown
 * fails the build instead of shipping a control that cannot express it.
 */
export const MACRO_CLASSES: readonly RetrainMacroClass[] = [
  'person',
  'vehicle',
  'animal',
  'package',
  'face',
  'plate',
]
/**
 * What an operator may CHOOSE: the trainer uses person, vehicle and animal
 * (package rides along); face and plate come from their own cropper models. An
 * existing face / plate box still renders and can be deleted (it stays in
 * {@link MACRO_CLASSES}, and in its own select option).
 */
export const OFFERED_MACRO_CLASSES: readonly RetrainMacroClass[] = [
  'person',
  'vehicle',
  'animal',
  'package',
]
const MACRO_SET: ReadonlySet<string> = new Set<string>(MACRO_CLASSES)

/** The tier guard, mirrored from the server so the operator learns it here. */
export function tierError(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase()
  if (trimmed === undefined || trimmed === '') return null
  return MACRO_SET.has(trimmed) ? translate('subject.tierError', { value: trimmed }) : null
}

/** Does every CONFIRMED box pass the tier guard? Drafts are not saved, so a
 *  draft's label cannot block a save. */
export function annotationsAreValid(boxes: readonly EditorBox[]): boolean {
  return boxes
    .filter((b) => !b.draft)
    .every(
      (b) =>
        tierError(b.label) === null &&
        tierError(b.subLabel) === null &&
        MACRO_SET.has(b.macroClass),
    )
}

function provenance(box: EditorBox, t: TFn): string | null {
  if (box.source === 'operator') return null
  const parts = [t(`source.${box.source}`)]
  if (box.assistModelId !== undefined) parts.push(box.assistModelId)
  if (box.assistScore !== undefined) parts.push(box.assistScore.toFixed(2))
  return parts.join(' · ')
}

export interface RetrainSubjectRowProps {
  readonly box: EditorBox
  readonly diff: BoxDiff | undefined
  readonly selected: boolean
  readonly hover: Hover | null
  readonly vocabulary: readonly VocabularyEntry[]
  readonly onHover: (hover: Hover | null) => void
  readonly onSelect: (key: string) => void
  /** A discrete edit (the class) — one undo step. */
  readonly onChange: (key: string, patch: EditorBoxPatch) => void
  /** Typing: focus → start, every keystroke → live, blur → end (one undo step). */
  readonly onEditStart: () => void
  readonly onEditLive: (key: string, patch: EditorBoxPatch) => void
  readonly onEditEnd: () => void
  readonly onAccept: (key: string) => void
  readonly onToggleModelError: (key: string) => void
  readonly onDelete: (key: string) => void
}

export function RetrainSubjectRow({
  box,
  diff,
  selected,
  hover,
  vocabulary,
  onHover,
  onSelect,
  onChange,
  onEditStart,
  onEditLive,
  onEditEnd,
  onAccept,
  onToggleModelError,
  onDelete,
}: RetrainSubjectRowProps): JSX.Element {
  const { t } = useT()
  const kind = diff?.kind ?? fallbackKind(box)
  const look = boxLook(kind)
  const rowRef = useRef<HTMLLIElement | null>(null)
  const hovered = hover?.key === box.key
  const hoveredFromCanvas = hovered && hover.source === 'canvas'
  useEffect(() => {
    if (hoveredFromCanvas) rowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [hoveredFromCanvas])

  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  const labelError = tierError(box.label)
  const subLabelError = tierError(box.subLabel)
  const origin = provenance(box, t)
  const was = originalClassText(diff, box.macroClass, box.label)
  const classChoices = OFFERED_MACRO_CLASSES.includes(box.macroClass)
    ? OFFERED_MACRO_CLASSES
    : [...OFFERED_MACRO_CLASSES, box.macroClass]
  const suggestions = selected ? suggestLabels(vocabulary, box.label ?? '', box.macroClass) : []
  const listId = `retrain-labels-${box.key}`

  const typing = (field: 'label' | 'subLabel') => ({
    onFocus: onEditStart,
    onBlur: onEditEnd,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') event.currentTarget.blur()
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      onEditLive(box.key, { [field]: event.target.value })
    },
  })

  return (
    <li
      ref={rowRef}
      data-testid={`retrain-row-${box.key}`}
      data-kind={kind}
      data-hovered={hovered ? 'true' : 'false'}
      className={`border-b border-border last:border-b-0 ${selected ? 'bg-surface-hover' : hovered ? 'bg-surface-hover/60' : ''}`}
      onMouseEnter={() => {
        onHover({ key: box.key, source: 'list' })
      }}
      onMouseLeave={() => {
        onHover(null)
      }}
    >
      <div className="flex h-9 items-center gap-1 pl-2 pr-1">
        <button // ui-check-ok: a row's select hit target; Button chrome would break the one-line row
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          aria-pressed={selected}
          onClick={() => {
            onSelect(box.key)
          }}
        >
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ background: look.stroke }} // ui-check-ok: the box's own stroke token, as a chip
          />
          <RetrainReviewBadge kind={kind} size="sm" approximate={diff?.approximate === true} />
          {was !== null ? (
            <span
              className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
              data-testid="retrain-row-was"
            >
              <span className="text-foreground-muted line-through">{was.original}</span>
              {' → '}
              {was.current}
            </span>
          ) : (
            <>
              <span className="shrink-0 text-[11px] text-foreground-muted">{box.macroClass}</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {box.label ?? ''}
              </span>
            </>
          )}
          <RetrainSourceIcon
            source={box.source}
            size={14}
            className="shrink-0 text-foreground-subtle"
          />
        </button>
        {(box.note !== undefined || box.flag !== undefined) && (
          <Tooltip>
            <TooltipTrigger>
              <Info
                className={`h-3.5 w-3.5 ${box.flag !== undefined && box.flag.verdict !== 'confirmed' ? 'text-warning' : 'text-foreground-subtle'}`}
                aria-label={t('subject.why')}
              />
            </TooltipTrigger>
            <TooltipContent className="w-64 whitespace-normal text-left">
              {box.note !== undefined && <p>{box.note}</p>}
              {box.flag !== undefined && (
                <p>
                  {box.flag.by}: {box.flag.verdict}
                  {box.flag.suggestedClass !== undefined
                    ? ` (${t('subject.suggests', { class: box.flag.suggestedClass })})`
                    : ''}{' '}
                  — {box.flag.reason}
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        )}
        {box.draft && (
          <Button
            variant="secondary"
            size="sm"
            aria-label={t('subject.accept')}
            onClick={() => {
              onAccept(box.key)
            }}
          >
            <Check className="h-3 w-3" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('subject.delete')}
          onClick={() => {
            onDelete(box.key)
          }}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      {selected && (
        <div className="space-y-1.5 px-2 pb-2" data-testid={`retrain-edit-${box.key}`}>
          <div className="flex items-center gap-2">
            <div className="w-28 shrink-0">
              <Select
                aria-label={t('subject.class')}
                value={box.macroClass}
                options={classChoices.map((c, i) => ({
                  value: c,
                  label: `${String(i + 1)} · ${c}`,
                }))}
                onChange={(event) => {
                  const next = classChoices.find((c) => c === event.target.value)
                  if (next !== undefined) onChange(box.key, { macroClass: next })
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <Input
                aria-label={t('subject.label')}
                list={listId}
                autoComplete="off"
                placeholder={t('subject.labelPlaceholder')}
                value={box.label ?? ''}
                {...typing('label')}
              />
            </div>
            <datalist id={listId}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <Input
            aria-label={t('subject.subLabel')}
            autoComplete="off"
            placeholder={t('subject.subLabelPlaceholder')}
            value={box.subLabel ?? ''}
            {...typing('subLabel')}
          />
          {labelError !== null && <p className="text-[11px] text-danger">{labelError}</p>}
          {subLabelError !== null && <p className="text-[11px] text-danger">{subLabelError}</p>}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onToggleModelError(box.key)
              }}
            >
              <Ban className="h-3 w-3" />
              <span className="ml-1">
                {box.kind === 'model_error'
                  ? t('subject.realSubject')
                  : t('subject.markModelError')}
              </span>
            </Button>
            <span className="min-w-0 flex-1 truncate text-right text-[11px] text-foreground-subtle">
              {origin ?? t('subject.drawnByYou')}
            </span>
          </div>
        </div>
      )}
    </li>
  )
}
