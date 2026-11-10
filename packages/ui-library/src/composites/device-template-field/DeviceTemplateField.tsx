import {
  type MutableRefObject,
  type ReactNode,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Braces } from 'lucide-react'
import { useUiText } from '../../contexts/ui-text'
import {
  useDeviceManagerCheckDeviceTemplates,
  useDeviceManagerListAll,
  useDeviceManagerRenderDeviceTemplates,
} from '../../generated/system-hooks'
import { useDebouncedString } from '../../hooks/use-debounced-string'
import { IconButton } from '../../primitives/icon-button'
import { Input } from '../../primitives/input'
import { Textarea } from '../../primitives/textarea'
import { SelectedChip } from '../device-picker/SelectedChip'
import { DeviceTemplateInsert } from './device-template-insert'
import {
  carriesDeviceTemplate,
  type DeviceTemplateHeldSlots,
  chipLabel,
  type DeviceTemplateAccepts,
  hasDeviceRefs,
  insertTemplateToken,
  parseTemplateSegments,
  type TemplateSegment,
  textForDeviceCheck,
} from './device-template-model'

const CHECK_DEBOUNCE_MS = 400

/** What a host drives from outside: a button of its own that writes at the caret. */
export interface DeviceTemplateFieldHandle {
  /** Insert `text` at the caret; `cursorOffset` is where the caret lands inside it (default: after it). */
  readonly insertText: (text: string, cursorOffset?: number) => void
}

export interface DeviceTemplateFieldProps {
  readonly handle?: MutableRefObject<DeviceTemplateFieldHandle | null>
  readonly value: string
  readonly onChange: (next: string) => void
  readonly label: string
  /** The kind of value the slot takes; the insert dialog offers only fields that fit. Default `any`. */
  readonly accepts?: DeviceTemplateAccepts
  readonly multiline?: boolean
  readonly placeholder?: string
  readonly disabled?: boolean
  /** Which `{{…}}` the consumer fills itself and the hub is not asked about. Default `vars` (an action run). */
  readonly heldSlots?: DeviceTemplateHeldSlots
  /** Show the rendered text under the field (one hub call per pause in typing). */
  readonly preview?: boolean
  /** Devices the end caller may read; a template naming another is refused. */
  readonly allowedDeviceIds?: readonly number[]
  readonly className?: string
  readonly testId?: string
  readonly capTitle?: (cap: string) => string
  readonly fieldLabel?: (cap: string, path: string) => string
}

type RefSegment = Extract<TemplateSegment, { kind: 'ref' }>

/**
 * A text field for a device template (`{{ alias.field | filter }}`). Device references
 * show as chips (alias.field, the device name on hover) until the field is edited; an
 * "insert value" button picks device → field and writes the token. The hub vets the text
 * (`checkDeviceTemplates`) after a pause in typing and the refusal shows under the field.
 */
export function DeviceTemplateField(props: DeviceTemplateFieldProps): ReactNode {
  const t = useUiText()
  const { value, onChange, accepts = 'any', multiline = false, disabled = false } = props
  const testId = props.testId ?? 'device-template-field'
  const [editing, setEditing] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const element = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const selection = useRef({ start: value.length, end: value.length })
  const segments = useMemo(() => parseTemplateSegments(value), [value])
  const chips = hasDeviceRefs(value) && !editing

  const all = useDeviceManagerListAll({ projection: 'slim' })
  const nameOf = useMemo(() => {
    const names = new Map<string, string>()
    for (const d of all.data ?? []) if (d.alias !== undefined) names.set(d.alias, d.name)
    return names
  }, [all.data])

  const remember = (): void => {
    selection.current = {
      start: element.current?.selectionStart ?? value.length,
      end: element.current?.selectionEnd ?? value.length,
    }
  }
  const insertText = (text: string, cursorOffset?: number): void => {
    const result = insertTemplateToken(value, selection.current, text)
    const cursor = result.cursor - text.length + (cursorOffset ?? text.length)
    onChange(result.value)
    selection.current = { start: cursor, end: cursor }
    setEditing(true)
    requestAnimationFrame(() => {
      element.current?.focus()
      element.current?.setSelectionRange(cursor, cursor)
    })
  }
  useImperativeHandle(props.handle, () => ({ insertText }))
  const insert = (token: string): void => insertText(token)
  const removeRef = (segment: RefSegment): void => {
    onChange(
      segments.map((s) => (s === segment ? '' : s.kind === 'text' ? s.text : s.raw)).join(''),
    )
  }

  const common = {
    'aria-label': props.label,
    value,
    disabled,
    placeholder: props.placeholder,
    onChange: (e: { target: { value: string } }): void => {
      onChange(e.target.value)
      remember()
    },
    onSelect: remember,
    onBlur: (): void => setEditing(false),
    'data-testid': `${testId}-input`,
  }

  return (
    <div className={props.className ?? 'flex flex-col gap-1'} data-testid={testId}>
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          {chips ? (
            <div
              role="textbox"
              tabIndex={disabled ? -1 : 0}
              aria-label={props.label}
              aria-readonly="true"
              data-testid={`${testId}-chips`}
              className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary"
              onFocus={() => {
                if (disabled) return
                setEditing(true)
                requestAnimationFrame(() => element.current?.focus())
              }}
              onClick={() => {
                if (disabled) return
                setEditing(true)
                requestAnimationFrame(() => element.current?.focus())
              }}
              onKeyDown={() => undefined}
            >
              {segments.map((segment, index) =>
                segment.kind === 'text' ? (
                  <span key={`t${String(index)}`} className="whitespace-pre-wrap">
                    {segment.text}
                  </span>
                ) : (
                  <span
                    key={`r${String(index)}`}
                    title={nameOf.get(segment.alias) ?? segment.alias}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={() => undefined}
                    role="presentation"
                  >
                    <SelectedChip
                      label={chipLabel(segment)}
                      warning={all.status === 'success' && !nameOf.has(segment.alias)}
                      onRemove={disabled ? undefined : () => removeRef(segment)}
                      testId={`${testId}-chip`}
                    />
                  </span>
                ),
              )}
            </div>
          ) : multiline ? (
            <Textarea ref={element} rows={2} autoFocus={editing} {...common} />
          ) : (
            <Input ref={element} autoFocus={editing} {...common} />
          )}
        </div>
        <IconButton
          type="button"
          variant="outline"
          size="sm"
          icon={Braces}
          aria-label={t('uiLibrary.deviceTemplateField.insertValue', 'Insert a device value')}
          title={t('uiLibrary.deviceTemplateField.insertValue', 'Insert a device value')}
          disabled={disabled}
          data-testid={`${testId}-insert`}
          // Keep the caret where it is: a mousedown would blur the box before the click.
          onMouseDown={(e) => {
            e.preventDefault()
            remember()
          }}
          onClick={() => setDialogOpen(true)}
        />
      </div>
      <TemplateFeedback
        value={value}
        preview={props.preview === true}
        heldSlots={props.heldSlots}
        allowedDeviceIds={props.allowedDeviceIds}
        testId={testId}
      />
      <DeviceTemplateInsert
        accepts={accepts}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onInsert={insert}
        capTitle={props.capTitle}
        fieldLabel={props.fieldLabel}
      />
    </div>
  )
}

interface TemplateFeedbackProps {
  readonly heldSlots?: DeviceTemplateHeldSlots
  readonly value: string
  readonly preview: boolean
  readonly allowedDeviceIds: readonly number[] | undefined
  readonly testId: string
}

/** The hub's verdict on the text: a refusal, an unknown device name, or the rendered preview. */
function TemplateFeedback({
  heldSlots,
  value,
  preview,
  allowedDeviceIds,
  testId,
}: TemplateFeedbackProps): ReactNode {
  const t = useUiText()
  const settled = useDebouncedString(value, CHECK_DEBOUNCE_MS)
  // Plain text carries no device reference: nothing to vet, nothing to ask the hub.
  const worth = carriesDeviceTemplate(settled, heldSlots)
  const text = textForDeviceCheck(settled, heldSlots)
  const allowed = allowedDeviceIds === undefined ? undefined : [...allowedDeviceIds]
  const check = useDeviceManagerCheckDeviceTemplates(
    { templates: [text], allowedDeviceIds: allowed },
    { enabled: worth },
  )
  const verdict = worth ? check.data?.results[0] : undefined
  const refused = verdict?.ok === false ? verdict.refusal.message : null
  const unknownAliases =
    verdict?.ok === true
      ? verdict.aliases.filter((a) => a.deviceId === null).map((a) => a.alias)
      : []
  const outOfScope =
    verdict?.ok === true ? verdict.aliases.filter((a) => a.deviceId !== null && !a.allowed) : []
  const vetted = verdict?.ok === true && unknownAliases.length === 0 && outOfScope.length === 0
  const rendered = useDeviceManagerRenderDeviceTemplates(
    { templates: [text], allowedDeviceIds: allowed },
    { enabled: preview && vetted },
  )
  const result = preview && vetted ? rendered.data?.results[0] : undefined
  return (
    <>
      {refused !== null && (
        <p role="alert" className="text-[11px] text-danger" data-testid={`${testId}-refusal`}>
          {refused}
        </p>
      )}
      {unknownAliases.length > 0 && (
        <p role="alert" className="text-[11px] text-danger" data-testid={`${testId}-unknown`}>
          {t('uiLibrary.deviceTemplateField.unknownDevice', 'No device is named {{names}}.', {
            names: unknownAliases.join(', '),
          })}
        </p>
      )}
      {outOfScope.length > 0 && (
        <p role="alert" className="text-[11px] text-danger" data-testid={`${testId}-scope`}>
          {t(
            'uiLibrary.deviceTemplateField.outOfScope',
            '{{names}} is outside what this can read.',
            {
              names: outOfScope.map((a) => a.alias).join(', '),
            },
          )}
        </p>
      )}
      {result?.ok === true && (
        <p className="text-[11px] text-foreground-muted" data-testid={`${testId}-preview`}>
          {t('uiLibrary.deviceTemplateField.preview', 'Now reads: {{text}}', {
            text: result.text,
          })}
        </p>
      )}
    </>
  )
}
