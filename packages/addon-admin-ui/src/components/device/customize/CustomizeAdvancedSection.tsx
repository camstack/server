/**
 * In-tab Advanced parameters derived from opted-in caps (D941).
 * Each row is the same override row as a card: no free text input.
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  compositionSourceKey,
  type CustomizeCatalogAdvancedParameter,
  type DeviceInfo,
} from '@camstack/types'
import { CollapsibleCard } from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDeviceManagerGetBindings } from '@camstack/ui-library'
import { useCandidateDevices } from './assignments/use-source-candidates'
import type { CustomizationHandle } from './use-customization'
import { OverrideFieldRow } from './override-row/OverrideFieldRow'

function isCatalogCap(cap: string): cap is keyof typeof CAP_CUSTOMIZE_CATALOG {
  return Object.hasOwn(CAP_CUSTOMIZE_CATALOG, cap)
}

interface ParamRow {
  readonly cap: string
  readonly param: CustomizeCatalogAdvancedParameter
}

export interface CustomizeAdvancedSectionProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
}

export function CustomizeAdvancedSection({
  device,
  handle,
}: CustomizeAdvancedSectionProps): ReactNode {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const bindings = useDeviceManagerGetBindings({ deviceId: device.id })
  const devices = useCandidateDevices(expanded)
  const names = useMemo(() => {
    if (devices.kind !== 'known') return new Map<string, string>()
    return new Map(
      devices.value.map((row) => [
        compositionSourceKey({ addonId: row.addonId, stableId: row.stableId }),
        row.name,
      ]),
    )
  }, [devices])
  const rows = useMemo((): readonly ParamRow[] => {
    if (bindings.data === undefined) return []
    const out: ParamRow[] = []
    for (const entry of bindings.data.entries) {
      const cap = entry.capName
      const params = isCatalogCap(cap) ? CAP_CUSTOMIZE_CATALOG[cap].advancedParameters : []
      for (const param of params) out.push({ cap, param })
    }
    return out
  }, [bindings.data])
  if (rows.length === 0) return null

  return (
    <CollapsibleCard
      expanded={expanded}
      onExpandedChange={setExpanded}
      header={
        <span
          className="text-sm font-medium text-foreground"
          data-testid="customize-advanced-section-header"
        >
          {t('customize.advancedSection.title')}
        </span>
      }
    >
      <div className="flex flex-col gap-3 p-3 sm:p-4">
        {rows.map(({ cap, param }) => (
          <OverrideFieldRow
            key={`${cap}:${param.path}`}
            deviceId={device.id}
            self={handle.target}
            selfName={device.name}
            cap={cap}
            fieldPath={param.path}
            label={param.unit !== undefined ? `${param.label} (${param.unit})` : param.label}
            unit={param.unit}
            valueKind={param.kind}
            handle={handle}
            names={names}
          />
        ))}
      </div>
    </CollapsibleCard>
  )
}
