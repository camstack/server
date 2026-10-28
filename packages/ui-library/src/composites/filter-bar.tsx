import { useState, type JSX } from 'react'
import { Search, SlidersHorizontal } from 'lucide-react'
import { cn } from '../lib/cn'
import { useUiText } from '../contexts/ui-text'
import { Input, Select, Badge, BottomSheet } from '../primitives'
import { useIsMobile } from '../hooks/use-is-mobile'

type FilterDef =
  | { type: 'search'; key: string; placeholder?: string }
  | { type: 'select'; key: string; label: string; options: { value: string; label: string }[] }
  | { type: 'badge-toggle'; key: string; options: { value: string; label: string }[] }

export type { FilterDef }

export interface FilterBarProps {
  filters: FilterDef[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  className?: string
}

export function FilterBar({
  filters,
  values,
  onChange,
  className,
}: FilterBarProps): JSX.Element | null {
  const t = useUiText()
  const isMobile = useIsMobile()
  const [sheetOpen, setSheetOpen] = useState(false)

  const handleChange = (key: string, value: unknown) => {
    onChange({ ...values, [key]: value })
  }

  const activeCount = Object.values(values).filter((v) => v !== undefined && v !== '').length

  if (isMobile) {
    const searchFilter = filters.find((f) => f.type === 'search')
    const hasNonSearchFilters = filters.some((f) => f.type !== 'search')

    return (
      <div className={cn('flex items-center gap-2', className)}>
        {searchFilter && (
          <Input
            placeholder={searchFilter.placeholder ?? t('uiLibrary.filterBar.search', 'Search...')}
            value={(values[searchFilter.key] as string) ?? ''}
            onChange={(e) => handleChange(searchFilter.key, e.target.value)}
            searchHotkey
            leftSlot={<Search className="h-3 w-3 text-foreground-subtle" />}
            className="flex-1"
          />
        )}
        {hasNonSearchFilters && (
          <>
            <button
              onClick={() => setSheetOpen(true)}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground-muted hover:bg-surface-hover transition-colors shrink-0"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {t('uiLibrary.filterBar.filters', 'Filters')}
              {activeCount > 0 && (
                <Badge variant="info" className="ml-1 text-[10px] px-1 py-0">
                  {activeCount}
                </Badge>
              )}
            </button>
            <BottomSheet
              open={sheetOpen}
              onClose={() => setSheetOpen(false)}
              title={t('uiLibrary.filterBar.filters', 'Filters')}
            >
              <div className="flex flex-col gap-3">
                {filters
                  .filter((f) => f.type !== 'search')
                  .map((filter) => {
                    switch (filter.type) {
                      case 'select':
                        return (
                          <div key={filter.key}>
                            <label className="text-xs text-foreground-muted mb-1 block">
                              {filter.label}
                            </label>
                            <Select
                              options={filter.options}
                              value={(values[filter.key] as string) ?? ''}
                              onChange={(e) => handleChange(filter.key, e.target.value)}
                              className="w-full"
                            />
                          </div>
                        )
                      case 'badge-toggle':
                        return (
                          <div key={filter.key} className="flex items-center gap-1 flex-wrap">
                            {filter.options.map((option) => {
                              const currentValue = values[filter.key]
                              const isActive = currentValue === option.value
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() =>
                                    handleChange(filter.key, isActive ? undefined : option.value)
                                  }
                                >
                                  <Badge
                                    variant={isActive ? 'info' : 'default'}
                                    className="cursor-pointer"
                                  >
                                    {option.label}
                                  </Badge>
                                </button>
                              )
                            })}
                          </div>
                        )
                      default:
                        return null
                    }
                  })}
              </div>
            </BottomSheet>
          </>
        )}
      </div>
    )
  }

  return (
    <div className={cn('flex items-center gap-2 flex-wrap', className)}>
      {filters.map((filter) => {
        switch (filter.type) {
          case 'search':
            return (
              <Input
                key={filter.key}
                placeholder={filter.placeholder ?? t('uiLibrary.filterBar.search', 'Search...')}
                value={(values[filter.key] as string) ?? ''}
                onChange={(e) => handleChange(filter.key, e.target.value)}
                searchHotkey
                leftSlot={<Search className="h-3 w-3 text-foreground-subtle" />}
                className="w-48"
              />
            )
          case 'select':
            return (
              <Select
                key={filter.key}
                options={filter.options}
                value={(values[filter.key] as string) ?? ''}
                onChange={(e) => handleChange(filter.key, e.target.value)}
                className="w-36"
              />
            )
          case 'badge-toggle':
            return (
              <div key={filter.key} className="flex items-center gap-1">
                {filter.options.map((option) => {
                  const currentValue = values[filter.key]
                  const isActive = currentValue === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => handleChange(filter.key, isActive ? undefined : option.value)}
                    >
                      <Badge variant={isActive ? 'info' : 'default'} className="cursor-pointer">
                        {option.label}
                      </Badge>
                    </button>
                  )
                })}
              </div>
            )
          default:
            return null
        }
      })}
    </div>
  )
}
