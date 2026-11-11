/**
 * The names of the candidates a create-many form ticks, read from the SAME discovery query that
 * fills the picker (`useDiscoveredOptions`: one react-query entry, no second request, whatever
 * discovery the field declares). Mounted only while a form picks several values, so a dialog that
 * never does asks nothing.
 *
 * A failed read is said on screen: every record is then named after its raw value, and the
 * operator sees why before confirming.
 */
import type { ConfigSelectField } from '@camstack/types'
import { useDiscoveredOptions } from '@camstack/ui-library'
import { type ReactElement, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

export interface ManyPickLabelsProps {
  readonly field: ConfigSelectField
  readonly values: Readonly<Record<string, unknown>>
  readonly onLabels: (labels: ReadonlyMap<string, string>) => void
}

export function ManyPickLabels({
  field,
  values,
  onLabels,
}: ManyPickLabelsProps): ReactElement | null {
  const { t } = useTranslation()
  const { query, found } = useDiscoveredOptions(field, values)
  const key = found.map((option) => `${option.value}\u0000${option.label}`).join('\u0001')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the content of `found`
  useEffect(() => {
    onLabels(new Map(found.map((option) => [option.value, option.label])))
  }, [key, onLabels])
  if (!query.isError) return null
  return (
    <p data-testid="create-many-labels-failed" className="text-xs text-warning">
      {t(
        'providerInstances.createManyLabelsFailed',
        'The names of the choices could not be read ({{message}}); each is named after its value.',
        { message: query.error?.message ?? '' },
      )}
    </p>
  )
}
