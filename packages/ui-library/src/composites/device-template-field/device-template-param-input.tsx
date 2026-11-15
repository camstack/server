import {
  type DeviceTemplateParam,
  deviceTemplateCatalogueSentence,
  deviceTemplateParamChoices,
} from '@camstack/types/device-template-catalogue'
import { type ReactNode, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { humanizeIdentifier } from '../../lib/capability-label'
import { Input } from '../../primitives/input'
import { Select } from '../../primitives/select'

const CUSTOM = '__custom__'

export interface DeviceTemplateParamInputProps {
  readonly param: DeviceTemplateParam
  readonly id: string
  readonly testId: string
  readonly value: string
  readonly onChange: (next: string) => void
  /** The unit of the piped field, when known: narrows a `units-of-field` source. */
  readonly fieldUnit?: string
}

/**
 * One argument of a catalogue function. A parameter with a value source is a picker
 * (with "Custom…" for text, so a pattern nobody listed can still be typed); any other is free input.
 */
export function DeviceTemplateParamInput(props: DeviceTemplateParamInputProps): ReactNode {
  const t = useUiText()
  const groups = deviceTemplateParamChoices(props.param.values, props.fieldUnit)
  const listed = groups.some((group) => group.choices.some((c) => c.value === props.value))
  const [custom, setCustom] = useState(false)
  if (groups.length === 0) {
    return (
      <Input
        id={props.id}
        value={props.value}
        data-testid={props.testId}
        onChange={(e) => props.onChange(e.target.value)}
      />
    )
  }
  const text = props.param.type === 'string'
  const typing = text && (custom || (props.value !== '' && !listed))
  const labelOf = (value: string, labelKey: string | undefined): string =>
    labelKey === undefined
      ? value
      : `${value} · ${t(labelKey, deviceTemplateCatalogueSentence(labelKey, 'en') ?? value)}`
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        id={props.id}
        data-testid={props.testId}
        value={typing ? CUSTOM : props.value}
        placeholder={t('uiLibrary.deviceTemplateField.chooseValue', 'Choose a value')}
        onChange={(e) => {
          const next = e.target.value
          if (next === CUSTOM) {
            setCustom(true)
            props.onChange('')
            return
          }
          setCustom(false)
          props.onChange(next)
        }}
      >
        {props.param.optional && <option value="">—</option>}
        {groups.map((group) =>
          group.group === null ? (
            group.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {labelOf(c.value, c.labelKey)}
              </option>
            ))
          ) : (
            <optgroup key={group.group} label={humanizeIdentifier(group.group)}>
              {group.choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {labelOf(c.value, c.labelKey)}
                </option>
              ))}
            </optgroup>
          ),
        )}
        {text && (
          <option value={CUSTOM}>
            {t('uiLibrary.deviceTemplateField.customValue', 'Custom…')}
          </option>
        )}
      </Select>
      {typing && (
        <Input
          value={props.value}
          aria-label={t('uiLibrary.deviceTemplateField.customValue', 'Custom…')}
          data-testid={`${props.testId}-custom`}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
    </div>
  )
}
