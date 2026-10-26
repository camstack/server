import type { CustomizeEventEdge } from '@camstack/types'
import { Input, Select } from '@camstack/ui-library'
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

export interface NumberSecondsFieldProps {
  readonly label: string
  readonly value: number
  readonly onChange: (value: number) => void
}

export function NumberSecondsField({ label, value, onChange }: NumberSecondsFieldProps): ReactNode {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-foreground">
      {label}
      <Input
        type="number"
        aria-label={label}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next) && next >= 0) onChange(next)
        }}
      />
    </label>
  )
}
