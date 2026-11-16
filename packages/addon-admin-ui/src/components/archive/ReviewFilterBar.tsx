/**
 * Archive Review → the page-owned filters (zone, face / plate, debug). The
 * class filter is the event list's own kind menu. Every one of them narrows
 * the list and the density bar together (`review-filters.ts`).
 */
import { Checkbox, Select } from '@camstack/ui-library'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { IdentityFilter, ReviewFilters } from './review-filters'

export interface ReviewFilterBarProps {
  readonly filters: ReviewFilters
  readonly zones: readonly string[]
  readonly onChange: (next: ReviewFilters) => void
}

const ALL_ZONES = ''

function isIdentity(value: string): value is IdentityFilter {
  return value === 'any' || value === 'face' || value === 'plate'
}

export function ReviewFilterBar({ filters, zones, onChange }: ReviewFilterBarProps): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="contents" data-testid="archive-review-filters">
      {/* One zone is still a choice (that zone vs every zone); none is not. */}
      {zones.length > 0 && (
        <Select
          wrapperClassName="inline-block w-auto"
          aria-label={t('archive.review.zone', 'Zone')}
          value={filters.zone ?? ALL_ZONES}
          onChange={(e) =>
            onChange({
              ...filters,
              zone: e.target.value === ALL_ZONES ? null : e.target.value,
            })
          }
        >
          <option value={ALL_ZONES}>{t('archive.review.allZones', 'All zones')}</option>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>
      )}
      <Select
        wrapperClassName="inline-block w-auto"
        aria-label={t('archive.review.identity', 'Face or plate')}
        value={filters.identity}
        onChange={(e) => {
          const next = e.target.value
          if (isIdentity(next)) onChange({ ...filters, identity: next })
        }}
      >
        <option value="any">{t('archive.review.identityAny', 'Any subject')}</option>
        <option value="face">{t('archive.review.identityFace', 'With a face')}</option>
        <option value="plate">{t('archive.review.identityPlate', 'With a plate')}</option>
      </Select>
      <label className="flex items-center gap-2 text-xs text-foreground-subtle">
        <Checkbox
          checked={filters.debug}
          onChange={(e) => onChange({ ...filters, debug: e.target.checked })}
        />
        {t('archive.camera.debugFilter', 'Debug-marked tracks only')}
      </label>
    </div>
  )
}
