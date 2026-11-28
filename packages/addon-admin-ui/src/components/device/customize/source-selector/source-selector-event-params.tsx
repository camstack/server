import type { CustomizeEventEdge } from '@dominevo/types'
import { Select } from '@dominevo/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface EventEdgeFieldProps {
  readonly edges: readonly CustomizeEventEdge[]
  readonly edge: CustomizeEventEdge
  readonly onChange: (edge: CustomizeEventEdge) => void
}

export function EventEdgeField({ edges, edge, onChange }: EventEdgeFieldProps): ReactNode {
  const { t } = useTranslation()
  if (edges.length === 0) return null
  return (
    <label className="flex flex-col gap-1 text-[11px] text-foreground">
      {t('customize.event.edge')}
      <Select
        aria-label={t('customize.event.edge')}
        value={edge}
        options={edges.map((item) => ({
          value: item,
          label: t(`customize.event.edgeValue.${item}`),
        }))}
        onChange={(event) => {
          const next = edges.find((item) => item === event.target.value)
          if (next !== undefined) onChange(next)
        }}
      />
    </label>
  )
}
