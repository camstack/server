/**
 * A `select` whose options come from a notification kind's `discoverTargets`,
 * asked for the form's CURRENT values.
 *
 * Nothing is fetched until every `dependsOn` field has a value, so a kind that
 * needs a broker or a token is never asked without it. Each state is its own
 * line (not yet / loading / failed / nothing found) and the field stays a free
 * text input in all of them but "found", so the operator is never stuck behind
 * a list that did not come.
 */
import { useMemo, type JSX } from 'react'
import type { ConfigSelectField } from '@camstack/types'
import { useNotificationOutputDiscoverTargets } from '../generated/system-hooks'
import { useUiText } from '../contexts/ui-text'
import { useDebouncedString } from '../hooks/use-debounced-string'
import { Input } from '../primitives/input'
import { OptionSelect } from './option-select/OptionSelect'

const TYPING_DEBOUNCE_MS = 500

export interface DiscoveredOption {
  readonly value: string
  readonly label: string
}

type ConfigValue = string | number | boolean

function isConfigValue(value: unknown): value is ConfigValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null
}

/** The non-empty scalar form values: what the provider is asked about. */
function discoveryConfig(values: Readonly<Record<string, unknown>>): Record<string, ConfigValue> {
  const config: Record<string, ConfigValue> = {}
  for (const [key, value] of Object.entries(values)) {
    if (isConfigValue(value) && hasValue(value)) config[key] = value
  }
  return config
}

function optionsFrom(
  candidates: readonly {
    readonly suggestedName: string
    readonly config: Record<string, unknown>
  }[],
  key: string,
): readonly DiscoveredOption[] {
  const seen = new Set<string>()
  const options: DiscoveredOption[] = []
  for (const candidate of candidates) {
    const raw = candidate.config[key]
    if (typeof raw !== 'string' || raw === '' || seen.has(raw)) continue
    seen.add(raw)
    options.push({ value: raw, label: candidate.suggestedName })
  }
  return options
}

export interface DiscoveredOptionsState {
  readonly ready: boolean
  readonly settled: boolean
  readonly query: ReturnType<typeof useNotificationOutputDiscoverTargets>
  /** The options the provider answered with; empty until it did. */
  readonly found: readonly DiscoveredOption[]
}

/**
 * The discovery query behind a `select` field with `discoverOptions`, asked for
 * the form's CURRENT values. The control and the host form share one react-query
 * entry (same key), so a host that needs the option labels (a name derived from
 * the picked device) pays no second request.
 */
export function useDiscoveredOptions(
  field: ConfigSelectField,
  values: Readonly<Record<string, unknown>>,
): DiscoveredOptionsState {
  const discover = field.discoverOptions
  const kind = discover?.kind ?? ''
  const dependsOn = discover?.dependsOn ?? []
  const ready = discover !== undefined && dependsOn.every((key) => hasValue(values[key]))
  const config = useMemo(() => discoveryConfig(values), [values])
  // A token being typed changes on every key; ask once it settles.
  const configKey = JSON.stringify(config)
  const settled = configKey === useDebouncedString(configKey, TYPING_DEBOUNCE_MS)
  const query = useNotificationOutputDiscoverTargets(
    { kind, config },
    { enabled: ready && settled, retry: false },
  )
  const found =
    ready && settled && query.data !== undefined ? optionsFrom(query.data, field.key) : []
  return { ready, settled, query, found }
}

export function ConfigDiscoveredSelectControl({
  field,
  values,
  value,
  onChange,
  disabled,
  controlId,
}: {
  readonly field: ConfigSelectField
  readonly values: Readonly<Record<string, unknown>>
  readonly value: unknown
  readonly onChange: (next: string) => void
  readonly disabled?: boolean
  readonly controlId: string
}): JSX.Element {
  const t = useUiText()
  const { ready, settled, query, found } = useDiscoveredOptions(field, values)

  const current = value === undefined || value === null ? '' : String(value)
  const disabledNow = disabled || field.disabled

  if (found.length > 0) {
    const known = found.some((option) => option.value === current)
    return (
      <OptionSelect
        mode="single"
        singleDisplay="field"
        searchable
        disabled={disabledNow}
        value={current}
        onChange={onChange}
        placeholder={t('uiLibrary.configFormField.select', '— Select —')}
        options={[
          // A stored value the list no longer offers stays selectable.
          ...(current !== '' && !known ? [{ value: current, label: current }] : []),
          ...found,
        ]}
        testId={controlId}
        optionTestIdPrefix={`${controlId}-option`}
      />
    )
  }

  let status: string
  if (!ready) {
    status = t(
      'uiLibrary.configFormField.discoverNotReady',
      'Fill in the fields above to load the list, or type the value.',
    )
  } else if (!settled || query.isLoading || query.isFetching) {
    status = t('uiLibrary.configFormField.loadingOptions', 'Loading options…')
  } else if (query.isError) {
    status = t(
      'uiLibrary.configFormField.discoverFailed',
      'Could not load the list: {{message}}. Type the value instead.',
      {
        message: query.error instanceof Error ? query.error.message : String(query.error),
      },
    )
  } else {
    status = t(
      'uiLibrary.configFormField.discoverEmpty',
      'Nothing was found. Type the value instead.',
    )
  }

  return (
    <div className="space-y-1">
      <Input
        id={controlId}
        value={current}
        placeholder={field.placeholder}
        disabled={disabledNow}
        onChange={(e) => onChange(e.target.value)}
      />
      <p
        data-testid={`${controlId}-status`}
        className={`text-[11px] ${query.isError ? 'text-danger' : 'text-foreground-subtle'}`}
      >
        {status}
      </p>
    </div>
  )
}
