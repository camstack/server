/**
 * AdminSectionedPage — `SectionedPage` wired to react-router `?tab=` (or
 * `paramName`) so admin-ui hooks (`useSearchParams`, deep links, Navigate)
 * stay in sync. Addon federated pages import `SectionedPage` directly.
 */
import { SectionedPage, type SectionedPageProps } from '@camstack/ui-library'
import { useCallback, type JSX } from 'react'
import { useSearchParams } from 'react-router-dom'

export type AdminSectionedPageProps = Omit<SectionedPageProps, 'activeSection' | 'onSectionChange'>

export function AdminSectionedPage({
  paramName = 'tab',
  defaultSection,
  sections,
  ...rest
}: AdminSectionedPageProps): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams()
  const fallback = defaultSection ?? sections[0]?.id ?? ''
  const raw = searchParams.get(paramName)
  const activeSection = sections.some((s) => s.id === raw) ? (raw ?? fallback) : fallback

  const onSectionChange = useCallback(
    (id: string, ownedParamsToClear: readonly string[]): void => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const key of ownedParamsToClear) next.delete(key)
          next.set(paramName, id)
          return next
        },
        { replace: true },
      )
    },
    [paramName, setSearchParams],
  )

  return (
    <SectionedPage
      {...rest}
      paramName={paramName}
      defaultSection={defaultSection}
      sections={sections}
      activeSection={activeSection}
      onSectionChange={onSectionChange}
    />
  )
}
