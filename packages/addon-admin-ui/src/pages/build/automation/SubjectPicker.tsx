/**
 * WHAT a detection-shaped row is about: a macro class, then an optional label
 * that narrows it.
 *
 * The labels come from where they live (`DETECTION_LABEL_SOURCES`): an animal's
 * species and a vehicle's kind from the taxonomy (`subClassesOf`), a person's
 * name from the face gallery, a plate from the plate gallery. The galleries are
 * asked only when their macro is picked, and a gallery that has not answered
 * offers no choices — it never claims a stored label does not exist.
 *
 * A stored label the lists do not (yet) hold stays selectable, so re-saving
 * never rewrites it into something the operator did not choose.
 */

import { DETECTION_LABEL_SOURCES, type DetectionSubject, subClassesOf } from '@camstack/types'
import {
  Button,
  Input,
  Select,
  type SelectOption,
  useFaceGalleryListIdentities,
  usePlateGalleryListPlates,
} from '@camstack/ui-library'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

type Macro = DetectionSubject['macro']
type Labelled = Exclude<Macro, 'other'>

const MACROS: readonly Macro[] = ['animal', 'person', 'vehicle', 'package', 'other']

/** The macro a native select value names; anything else is `other`. */
function asMacro(value: string): Macro {
  const hit = MACROS.find((m) => m === value)
  return hit ?? 'other'
}

function blankSubject(macro: Macro): DetectionSubject {
  switch (macro) {
    case 'animal':
      return { macro: 'animal' }
    case 'person':
      return { macro: 'person' }
    case 'vehicle':
      return { macro: 'vehicle' }
    case 'package':
      return { macro: 'package' }
    default:
      return { macro: 'other', className: '' }
  }
}

function useMacroLabel(): (macro: Macro) => string {
  const { t } = useTranslation()
  return (macro) => {
    switch (macro) {
      case 'person':
        return t('flow.class.person', 'Person')
      case 'vehicle':
        return t('flow.class.vehicle', 'Vehicle')
      case 'animal':
        return t('flow.class.animal', 'Animal')
      case 'package':
        return t('flow.class.package', 'Package')
      default:
        return t('automation.whenTree.macroOther', 'Other class')
    }
  }
}

/** A subject of `macro` narrowed to one sub-class (a person has none). */
function withSubClass(macro: Labelled, className: string): DetectionSubject {
  const label = { kind: 'sub-class', className } as const
  switch (macro) {
    case 'animal':
      return { macro, label }
    case 'package':
      return { macro, label }
    case 'vehicle':
      return { macro, label }
    default:
      return { macro: 'person' }
  }
}

/** Sub-classes the taxonomy files under a macro, without the macro's own name. */
function subClassOptions(macro: Labelled, stored: string | undefined): readonly SelectOption[] {
  const names = subClassesOf(macro).filter((name) => name !== macro)
  const all = stored !== undefined && !names.includes(stored) ? [...names, stored] : names
  return all.map((name) => ({ value: name, label: name }))
}

interface LabelSelectProps {
  readonly subject: Exclude<DetectionSubject, { macro: 'other' }>
  readonly onChange: (next: DetectionSubject) => void
}

function SubClassSelect({ subject, onChange }: LabelSelectProps) {
  const { t } = useTranslation()
  const stored = subject.label?.kind === 'sub-class' ? subject.label.className : undefined
  const options = subClassOptions(subject.macro, stored)
  if (options.length === 0) return null
  return (
    <Select
      aria-label={t('automation.whenTree.labelAria', 'Narrow to')}
      data-testid="subject-label"
      value={stored ?? ''}
      options={[{ value: '', label: t('automation.whenTree.anyLabel', 'Any') }, ...options]}
      onChange={(e) => {
        const className = e.target.value
        onChange(
          className === '' ? blankSubject(subject.macro) : withSubClass(subject.macro, className),
        )
      }}
    />
  )
}

function IdentitySelect({ onChange, subject }: LabelSelectProps) {
  const { t } = useTranslation()
  const identities = useFaceGalleryListIdentities()
  const stored = subject.macro === 'person' ? subject.label : undefined
  const known = identities.data ?? []
  const options: SelectOption[] = known.map((i) => ({ value: i.id, label: i.name }))
  if (stored !== undefined && !known.some((i) => i.id === stored.identityId)) {
    options.push({ value: stored.identityId, label: stored.name })
  }
  return (
    <Select
      aria-label={t('automation.whenTree.labelAria', 'Narrow to')}
      data-testid="subject-label"
      value={stored?.identityId ?? ''}
      options={[{ value: '', label: t('automation.whenTree.anyPerson', 'Anyone') }, ...options]}
      onChange={(e) => {
        const id = e.target.value
        const hit = options.find((o) => o.value === id)
        onChange(
          id === '' || hit === undefined
            ? { macro: 'person' }
            : { macro: 'person', label: { kind: 'identity', identityId: id, name: hit.label } },
        )
      }}
    />
  )
}

const PLATE_PREFIX = 'plate:'
const CLASS_PREFIX = 'class:'
const PLATE_LIST_LIMIT = 200

function VehicleLabelSelect({ onChange, subject }: LabelSelectProps) {
  const { t } = useTranslation()
  const plates = usePlateGalleryListPlates({ includeCrops: false, limit: PLATE_LIST_LIMIT })
  const label = subject.macro === 'vehicle' ? subject.label : undefined
  const storedPlate = label?.kind === 'plate' ? label.text : undefined
  const storedClass = label?.kind === 'sub-class' ? label.className : undefined
  const texts = [...new Set((plates.data ?? []).map((p) => p.text))]
  if (storedPlate !== undefined && !texts.includes(storedPlate)) texts.push(storedPlate)
  const value =
    storedPlate !== undefined
      ? `${PLATE_PREFIX}${storedPlate}`
      : storedClass !== undefined
        ? `${CLASS_PREFIX}${storedClass}`
        : ''
  return (
    <Select
      aria-label={t('automation.whenTree.labelAria', 'Narrow to')}
      data-testid="subject-label"
      value={value}
      options={[
        { value: '', label: t('automation.whenTree.anyLabel', 'Any') },
        ...subClassOptions('vehicle', storedClass).map((o) => ({
          value: `${CLASS_PREFIX}${o.value}`,
          label: o.label,
        })),
        ...texts.map((text) => ({
          value: `${PLATE_PREFIX}${text}`,
          label: t('automation.whenTree.plateOption', 'Plate {{text}}', { text }),
        })),
      ]}
      onChange={(e) => {
        const next = e.target.value
        if (next.startsWith(PLATE_PREFIX)) {
          onChange({
            macro: 'vehicle',
            label: { kind: 'plate', text: next.slice(PLATE_PREFIX.length) },
          })
        } else if (next.startsWith(CLASS_PREFIX)) {
          onChange({
            macro: 'vehicle',
            label: { kind: 'sub-class', className: next.slice(CLASS_PREFIX.length) },
          })
        } else {
          onChange({ macro: 'vehicle' })
        }
      }}
    />
  )
}

interface SubjectRowProps {
  readonly subject: DetectionSubject
  /** A parked object carries no face or plate; only a class can narrow it. */
  readonly classLabelsOnly: boolean
  readonly verb: string
  readonly onChange: (next: DetectionSubject) => void
  readonly onRemove: (() => void) | null
}

function SubjectRow({ subject, classLabelsOnly, verb, onChange, onRemove }: SubjectRowProps) {
  const { t } = useTranslation()
  const macroLabel = useMacroLabel()
  const sources = subject.macro === 'other' ? [] : DETECTION_LABEL_SOURCES[subject.macro]
  const wantsIdentity = sources.some((s) => s.kind === 'cap' && s.label === 'identity')
  const wantsPlate = sources.some((s) => s.kind === 'cap' && s.label === 'plate')
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="subject-row">
      <div className="w-36">
        <Select
          aria-label={t('automation.whenTree.macroAria', 'Class')}
          data-testid="subject-macro"
          value={subject.macro}
          options={MACROS.map((m) => ({ value: m, label: macroLabel(m) }))}
          onChange={(e) => {
            const macro = asMacro(e.target.value)
            if (macro !== subject.macro) onChange(blankSubject(macro))
          }}
        />
      </div>
      <span className="text-sm text-foreground-muted">{verb}</span>
      {subject.macro === 'other' ? (
        <Input
          className="w-40"
          aria-label={t('automation.whenTree.className', 'Class name')}
          data-testid="subject-class-name"
          placeholder={t('automation.whenTree.classNamePlaceholder', 'Class name')}
          value={subject.className}
          onChange={(e) => onChange({ macro: 'other', className: e.target.value })}
        />
      ) : wantsIdentity && !classLabelsOnly ? (
        <div className="w-44">
          <IdentitySelect subject={subject} onChange={onChange} />
        </div>
      ) : wantsPlate && !classLabelsOnly ? (
        <div className="w-44">
          <VehicleLabelSelect subject={subject} onChange={onChange} />
        </div>
      ) : (
        !wantsIdentity && (
          <div className="w-44">
            <SubClassSelect subject={subject} onChange={onChange} />
          </div>
        )
      )}
      {onRemove !== null && (
        <Button
          variant="ghost"
          onClick={onRemove}
          title={t('automation.whenTree.removeClass', 'Remove this class')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

export interface SubjectPickerProps {
  readonly subjects: readonly DetectionSubject[]
  /** Stationary rows may name no class at all, which means any. */
  readonly optional: boolean
  readonly classLabelsOnly: boolean
  readonly verb: string
  readonly onChange: (next: readonly DetectionSubject[]) => void
}

export function SubjectPicker({
  subjects,
  optional,
  classLabelsOnly,
  verb,
  onChange,
}: SubjectPickerProps) {
  const { t } = useTranslation()
  const canRemove = optional || subjects.length > 1
  return (
    <div className="space-y-2" data-testid="subject-picker">
      {subjects.map((subject, index) => (
        <SubjectRow
          // Subjects carry no id; the list has no order to disturb (any of them fires).
          key={`${subject.macro}-${String(index)}`}
          subject={subject}
          classLabelsOnly={classLabelsOnly}
          verb={index === 0 ? verb : t('automation.whenTree.orSubject', 'or')}
          onChange={(next) => onChange(subjects.map((s, i) => (i === index ? next : s)))}
          onRemove={canRemove ? () => onChange(subjects.filter((_, i) => i !== index)) : null}
        />
      ))}
      {subjects.length === 0 && (
        <p className="text-xs text-foreground-subtle">
          {t('flow.scene.anyClass', 'None picked: any class counts.')}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange([...subjects, blankSubject('person')])}
      >
        <Plus className="h-3.5 w-3.5" />{' '}
        {subjects.length === 0
          ? t('automation.whenTree.onlySomeClasses', 'Only some classes')
          : t('automation.whenTree.addClass', 'Add a class')}
      </Button>
    </div>
  )
}
