import {
  DEVICE_TEMPLATE_CATALOGUE,
  deviceTemplateCatalogueSentence,
  deviceTemplateSignature,
  type DeviceTemplateCatalogueEntry,
} from '@camstack/types/device-template-catalogue'
import { type ReactNode, useMemo, useState } from 'react'
import type { DeviceTemplateThisDevice } from '@camstack/types'
import { useUiText } from '../../contexts/ui-text'
import { Button } from '../../primitives/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import { Input } from '../../primitives/input'
import { Label } from '../../primitives/label'
import {
  type CatalogueCall,
  formatCatalogueArgs,
  insertCatalogueCall,
  templateFieldSource,
} from './device-template-model'
import { DeviceTemplateFeedback } from './device-template-feedback'
import { DeviceTemplateParamInput } from './device-template-param-input'
import { useTemplateFieldUnit } from './use-template-field-unit'

const CATEGORY_ORDER = [
  'number',
  'unit',
  'text',
  'state',
  'time',
  'fallback',
  'loop',
  'variable',
] as const

export interface DeviceTemplateFunctionProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly value: string
  readonly caret: number
  readonly onInsert: (next: string, cursor: number, selectStart: number, selectEnd: number) => void
  readonly heldSlots?: 'vars' | 'placeholders'
  readonly allowedDeviceIds?: readonly number[]
  readonly thisDevice?: DeviceTemplateThisDevice
  readonly testId: string
}

function defaultsFor(entry: DeviceTemplateCatalogueEntry): Readonly<Record<string, string>> {
  const raw: Record<string, string> = {}
  for (const item of entry.params) {
    if (item.default !== undefined) raw[item.name] = String(item.default)
  }
  return raw
}

function callOf(
  entry: DeviceTemplateCatalogueEntry,
  raw: Readonly<Record<string, string>>,
): CatalogueCall {
  return {
    kind: entry.kind,
    name: entry.name,
    args: entry.kind === 'variable' ? [] : formatCatalogueArgs(entry.params, raw),
  }
}

/**
 * Pick a catalogue function, fill its arguments, and see the current text with
 * it applied — the preview is the hub's, the same one the field uses.
 */
export function DeviceTemplateFunction(props: DeviceTemplateFunctionProps): ReactNode {
  const t = useUiText()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [raw, setRaw] = useState<Readonly<Record<string, string>>>({})
  const fieldUnit = useTemplateFieldUnit(
    templateFieldSource(props.value, props.caret),
    props.thisDevice?.deviceId,
  )
  const entry = DEVICE_TEMPLATE_CATALOGUE.find((item) => item.name === selected)
  const needle = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const visible = DEVICE_TEMPLATE_CATALOGUE.filter((item) => {
      if (needle === '') return true
      const sentence = deviceTemplateCatalogueSentence(item.descriptionKey, 'en') ?? ''
      return item.name.includes(needle) || sentence.toLowerCase().includes(needle)
    })
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: visible.filter((item) => item.category === category),
    })).filter((group) => group.items.length > 0)
  }, [needle])
  const candidate =
    entry === undefined
      ? ''
      : insertCatalogueCall(props.value, props.caret, callOf(entry, raw)).value
  const choose = (item: DeviceTemplateCatalogueEntry): void => {
    setSelected(item.name)
    setRaw(defaultsFor(item))
  }
  const close = (): void => {
    props.onOpenChange(false)
    setQuery('')
    setSelected(null)
    setRaw({})
  }
  const confirm = (): void => {
    if (entry === undefined) return
    const inserted = insertCatalogueCall(props.value, props.caret, callOf(entry, raw))
    const select = inserted.select
    props.onInsert(
      inserted.value,
      inserted.cursor,
      select?.start ?? inserted.cursor,
      select?.end ?? inserted.cursor,
    )
    close()
  }
  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? props.onOpenChange(true) : close())}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            {t('uiLibrary.deviceTemplateField.functionTitle', 'Insert a function')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Input
            value={query}
            aria-label={t('uiLibrary.deviceTemplateField.functionSearch', 'Search functions')}
            placeholder={t('uiLibrary.deviceTemplateField.functionSearch', 'Search functions')}
            data-testid={`${props.testId}-function-search`}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div
            className="mt-3 max-h-64 space-y-3 overflow-auto"
            data-testid={`${props.testId}-function-list`}
          >
            {groups.map((group) => (
              <div key={group.category}>
                <p className="text-[10px] uppercase tracking-wide text-foreground-muted">
                  {t(`uiLibrary.deviceTemplateField.category.${group.category}`, group.category)}
                </p>
                <div className="mt-1 flex flex-col gap-1">
                  {group.items.map((item) => (
                    <Button
                      key={item.name}
                      type="button"
                      variant={item.name === selected ? 'secondary' : 'ghost'}
                      className="justify-start font-mono text-xs"
                      data-testid={`${props.testId}-function-${item.name}`}
                      onClick={() => choose(item)}
                    >
                      {deviceTemplateSignature(item)}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {entry !== undefined && (
            <div className="mt-3 space-y-2" data-testid={`${props.testId}-function-detail`}>
              <p className="text-xs text-foreground">
                {t(
                  entry.descriptionKey,
                  deviceTemplateCatalogueSentence(entry.descriptionKey, 'en') ?? entry.name,
                )}
              </p>
              <p className="font-mono text-[11px] text-foreground-muted">
                {t(entry.exampleKey, deviceTemplateCatalogueSentence(entry.exampleKey, 'en') ?? '')}
              </p>
              {entry.params.map((item) => (
                <div key={item.name}>
                  <Label
                    htmlFor={`${props.testId}-arg-${item.name}`}
                    className="text-xs font-normal"
                  >
                    {item.name}
                    {item.optional
                      ? t('uiLibrary.deviceTemplateField.optional', ' (optional)')
                      : ''}
                  </Label>
                  <DeviceTemplateParamInput
                    param={item}
                    id={`${props.testId}-arg-${item.name}`}
                    testId={`${props.testId}-arg-${item.name}`}
                    value={raw[item.name] ?? ''}
                    fieldUnit={fieldUnit}
                    onChange={(next) => setRaw({ ...raw, [item.name]: next })}
                  />
                </div>
              ))}
              <DeviceTemplateFeedback
                value={candidate}
                preview
                heldSlots={props.heldSlots}
                allowedDeviceIds={props.allowedDeviceIds}
                thisDevice={props.thisDevice}
                testId={`${props.testId}-function-preview`}
              />
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {t('uiLibrary.deviceValueField.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={entry === undefined}
            data-testid={`${props.testId}-function-confirm`}
            onClick={confirm}
          >
            {t('uiLibrary.deviceTemplateField.insert', 'Insert')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
