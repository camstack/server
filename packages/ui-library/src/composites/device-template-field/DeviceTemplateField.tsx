import {
  DEVICE_TEMPLATE_CATALOGUE,
  deviceTemplateCameraValues,
  deviceTemplateRootVariables,
} from '@dominevo/types/device-template-catalogue'
import {
  type MutableRefObject,
  type ReactNode,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { DeviceTemplateThisDevice } from '@dominevo/types'
import { Braces, Info, Parentheses } from 'lucide-react'
import { useUiText } from '../../contexts/ui-text'
import {
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
} from '../../generated/system-hooks'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { iconButtonClass } from '../../primitives/icon-button'
import { Input } from '../../primitives/input'
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover'
import { Textarea } from '../../primitives/textarea'
import { SelectedChip } from '../device-picker/SelectedChip'
import { DeviceTemplateInsert } from './device-template-insert'
import { DeviceTemplateFeedback } from './device-template-feedback'
import { DeviceTemplateFunction } from './device-template-function'
import { DeviceTemplateSuggest } from './device-template-suggest'
import { useTemplateFieldUnit } from './use-template-field-unit'
import {
  applyTemplateSuggestion,
  type DeviceTemplateHeldSlots,
  chipLabel,
  type DeviceTemplateAccepts,
  hasDeviceRefs,
  insertTemplateToken,
  parseTemplateSegments,
  type TemplateSegment,
  type TemplateSuggestion,
  templateCaretContext,
  templateSuggestions,
  templateSuggestTrigger,
} from './device-template-model'

export const DEVICE_TEMPLATE_DOCS_URL: string =
  'https://dominevo.app/docs/day-to-day/device-templates'

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
  /** Show the rendered text under the field. Default on — the hub renders it. */
  readonly preview?: boolean
  /** Devices the end caller may read; a template naming another is refused. */
  readonly allowedDeviceIds?: readonly number[]
  /**
   * The device the text is written for. `camera` then names it (so a template copies
   * between devices), and the hub vets and previews against it. `values` are the
   * `camera.<name>` variables the consumer supplies.
   */
  readonly thisDevice?: DeviceTemplateThisDevice
  readonly className?: string
  readonly testId?: string
  readonly capTitle?: (cap: string) => string
  readonly fieldLabel?: (cap: string, path: string) => string
}

type RefSegment = Extract<TemplateSegment, { kind: 'ref' }>

function isSuggestKey(event: {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  code: string
}): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Space'
}

/**
 * The one device-template editor. A consumer passes the text, `onChange` and its
 * context; this owns the box, "+ Device value", "+ Function", Ctrl+Space, the
 * help link and the hub's validation and preview.
 */
export function DeviceTemplateField(props: DeviceTemplateFieldProps): ReactNode {
  const { value, onChange, accepts = 'any', multiline = false, disabled = false } = props
  const preview = props.preview !== false
  const testId = props.testId ?? 'device-template-field'
  const [editing, setEditing] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [functionOpen, setFunctionOpen] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [caret, setCaret] = useState(value.length)
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
  const context = templateCaretContext(value, caret)
  const fieldDeviceId =
    context.kind !== 'field'
      ? null
      : context.alias === 'camera'
        ? (props.thisDevice?.deviceId ?? null)
        : (all.data?.find((d) => d.alias === context.alias)?.id ?? null)
  const wireable = useDeviceManagerGetWireableFields(
    { deviceId: fieldDeviceId ?? 0 },
    { enabled: fieldDeviceId !== null },
  )
  const fieldUnit = useTemplateFieldUnit(
    context.kind === 'argument' ? context.source : null,
    props.thisDevice?.deviceId,
  )
  const suggestions = templateSuggestions(context, {
    fieldUnit,
    aliases: [...nameOf.entries()].map(([alias, label]) => ({ alias, label })),
    fields: (wireable.data?.caps ?? []).flatMap((cap) =>
      cap.fields
        .filter((field) => field.item !== true)
        .map((field) => ({ path: field.path, kind: field.kind })),
    ),
    includeCamera: props.thisDevice !== undefined,
    entries: DEVICE_TEMPLATE_CATALOGUE,
    cameraValues: [
      ...deviceTemplateCameraValues().map((item) => item.name),
      ...Object.keys(props.thisDevice?.values ?? {}),
    ],
    rootVariables: deviceTemplateRootVariables().map((item) => item.name),
  })
  const shownActive = suggestions.length === 0 ? 0 : active % suggestions.length

  const placeCaret = (cursor: number, selectStart = cursor, selectEnd = cursor): void => {
    selection.current = { start: selectStart, end: selectEnd }
    setCaret(selectEnd)
    setEditing(true)
    requestAnimationFrame(() => {
      element.current?.focus()
      element.current?.setSelectionRange(selectStart, selectEnd)
    })
  }
  const insertText = (text: string, cursorOffset?: number): void => {
    const result = insertTemplateToken(value, selection.current, text)
    const cursor = result.cursor - text.length + (cursorOffset ?? text.length)
    onChange(result.value)
    placeCaret(cursor)
  }
  useImperativeHandle(props.handle, () => ({ insertText }))
  const remember = (nextCaret?: number): void => {
    const start = nextCaret ?? element.current?.selectionStart ?? value.length
    const end = nextCaret ?? element.current?.selectionEnd ?? value.length
    selection.current = { start, end }
    setCaret(end)
  }
  const choose = (suggestion: TemplateSuggestion): void => {
    const result = applyTemplateSuggestion(value, caret, context, suggestion.replacement)
    onChange(result.value)
    setSuggestOpen(false)
    placeCaret(result.cursor)
  }
  const onKeyDown = (event: {
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
    code: string
    key: string
    preventDefault: () => void
  }): void => {
    if (isSuggestKey(event)) {
      event.preventDefault()
      setSuggestOpen(true)
      setActive(0)
      return
    }
    if (!suggestOpen) return
    if (event.key === 'Escape') {
      event.preventDefault()
      setSuggestOpen(false)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => index + 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (index <= 0 ? suggestions.length - 1 : index - 1))
      return
    }
    if (event.key !== 'Enter' && event.key !== 'Tab') return
    const chosen = suggestions[shownActive]
    if (chosen === undefined) return
    event.preventDefault()
    choose(chosen)
  }
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
    onChange: (e: { target: { value: string; selectionStart: number | null } }): void => {
      const next = e.target.value
      const nextCaret = e.target.selectionStart ?? next.length
      onChange(next)
      remember(nextCaret)
      if (templateSuggestTrigger(next, nextCaret)) {
        setSuggestOpen(true)
        setActive(0)
      } else if (templateCaretContext(next, nextCaret).kind === 'none') {
        setSuggestOpen(false)
      }
    },
    onSelect: (): void => remember(),
    onKeyDown,
    onBlur: (): void => setEditing(false),
    'data-testid': `${testId}-input`,
  }

  return (
    <div className={props.className ?? 'relative flex flex-col gap-1'} data-testid={testId}>
      <div className="flex flex-col gap-1.5">
        <FieldActions
          testId={testId}
          disabled={disabled}
          onInsert={() => setDialogOpen(true)}
          onFunction={() => setFunctionOpen(true)}
          onMouseDown={() => remember()}
        />
        <div className="relative min-w-0 flex-1">
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
              onKeyDown={onKeyDown}
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
                      warning={
                        all.status === 'success' &&
                        !nameOf.has(segment.alias) &&
                        !(props.thisDevice !== undefined && segment.alias === 'camera')
                      }
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
          <DeviceTemplateSuggest
            open={suggestOpen && !disabled}
            suggestions={suggestions}
            active={shownActive}
            testId={testId}
            onHover={setActive}
            onChoose={choose}
          />
        </div>
      </div>
      <DeviceTemplateFeedback
        value={value}
        preview={preview}
        heldSlots={props.heldSlots}
        allowedDeviceIds={props.allowedDeviceIds}
        thisDevice={props.thisDevice}
        testId={testId}
      />
      <DeviceTemplateInsert
        accepts={accepts}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onInsert={(token) => insertText(token)}
        thisDeviceId={props.thisDevice?.deviceId}
        capTitle={props.capTitle}
        fieldLabel={props.fieldLabel}
      />
      <DeviceTemplateFunction
        open={functionOpen}
        onOpenChange={setFunctionOpen}
        value={value}
        caret={caret}
        heldSlots={props.heldSlots}
        allowedDeviceIds={props.allowedDeviceIds}
        thisDevice={props.thisDevice}
        testId={testId}
        onInsert={(next, cursor, selectStart, selectEnd) => {
          onChange(next)
          placeCaret(cursor, selectStart, selectEnd)
        }}
      />
    </div>
  )
}

interface FieldActionsProps {
  readonly testId: string
  readonly disabled: boolean
  readonly onInsert: () => void
  readonly onFunction: () => void
  readonly onMouseDown: () => void
}

function FieldActions(props: FieldActionsProps): ReactNode {
  const t = useUiText()
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={props.disabled}
        data-testid={`${props.testId}-insert`}
        aria-label={t('uiLibrary.deviceTemplateField.deviceValue', '+ Device value')}
        onMouseDown={(e) => {
          e.preventDefault()
          props.onMouseDown()
        }}
        onClick={props.onInsert}
      >
        <Braces className="h-3.5 w-3.5 shrink-0" />
        {t('uiLibrary.deviceTemplateField.deviceValue', '+ Device value')}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={props.disabled}
        data-testid={`${props.testId}-function`}
        aria-label={t('uiLibrary.deviceTemplateField.function', '+ Function')}
        onMouseDown={(e) => {
          e.preventDefault()
          props.onMouseDown()
        }}
        onClick={props.onFunction}
      >
        <Parentheses className="h-3.5 w-3.5 shrink-0" />
        {t('uiLibrary.deviceTemplateField.function', '+ Function')}
      </Button>
      <Popover className="relative col-span-2 block">
        <PopoverTrigger
          aria-label={t('uiLibrary.deviceTemplateField.helpTitle', 'Template help')}
          data-testid={`${props.testId}-help`}
          className={cn(iconButtonClass('outline', 'sm'), 'w-full gap-1.5 text-xs font-medium')}
        >
          <Info className="h-4 w-4" aria-hidden="true" />
          {t('uiLibrary.deviceTemplateField.helpTitle', 'Template help')}
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-72 max-w-[calc(100vw-1rem)] text-xs text-foreground"
        >
          <span className="block">
            {t(
              'uiLibrary.deviceTemplateField.helpLine1',
              'Plain text is written as it is. {{ alias.field }} reads a device; camera means this camera.',
            )}
          </span>
          <span className="mt-1 block">
            {t(
              'uiLibrary.deviceTemplateField.helpLine2',
              "Ctrl+Space completes a name. | unit('°C') prints the unit. {{ now | time('HH:mm') }} is the clock.",
            )}
          </span>
          <a
            href={DEVICE_TEMPLATE_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block text-primary underline"
          >
            {t('uiLibrary.deviceTemplateField.docsLink', 'Template syntax')}
          </a>
        </PopoverContent>
      </Popover>
    </div>
  )
}
