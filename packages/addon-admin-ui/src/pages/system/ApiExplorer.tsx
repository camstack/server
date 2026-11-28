/**
 * System → API explorer (planning#595): pick a method the hub serves, fill its
 * input, run it with the operator's own session, read the answer.
 *
 * The method list is `apiCatalog.list` — read off the live router, capability
 * and core routes alike. `?method=<router.method>` selects one and scrolls to
 * it (the address `/system/api-explorer?method=…` redirects here).
 */
import { EmptyState, ErrorBox, SectionCard, Skeleton, trpc } from '@dominevo/ui-library'
import { Braces, MousePointerClick } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'
import { ApiMethodDetail } from '../../components/api-explorer/ApiMethodDetail'
import { ApiMethodTable } from '../../components/api-explorer/ApiMethodTable'
import { API_EXPLORER_METHOD_PARAM } from '../../lib/api-explorer'

export function ApiExplorerPage(): ReactNode {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedPath = searchParams.get(API_EXPLORER_METHOD_PARAM)
  const list = trpc.apiCatalog.list.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY })
  const detailRef = useRef<HTMLDivElement>(null)
  const selected = list.data?.methods.find((m) => m.path === selectedPath) ?? null

  const select = useCallback(
    (path: string): void => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set(API_EXPLORER_METHOD_PARAM, path)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // A deep link (or a pick on a phone, where the detail sits under the list)
  // brings the method into view once it is known.
  const selectedKey = selected?.path ?? null
  useEffect(() => {
    if (selectedKey === null) return
    detailRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [selectedKey])

  return (
    <AdminPage
      embedded
      icon={Braces}
      title={t('system.apiExplorer.title')}
      subtitle={t('system.apiExplorer.subtitle')}
    >
      {list.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : list.error !== null ? (
        <ErrorBox
          title={t('system.apiExplorer.couldNotLoad')}
          message={list.error.message}
          onRetry={() => void list.refetch()}
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <SectionCard
            headingId="api-explorer-methods"
            title={t('system.apiExplorer.methodsTitle', { count: list.data.methods.length })}
          >
            <div className="p-3 sm:p-4">
              <ApiMethodTable
                methods={list.data.methods}
                selectedPath={selectedPath}
                onSelect={select}
              />
            </div>
          </SectionCard>
          <div ref={detailRef} className="min-w-0 scroll-mt-4">
            {selected !== null ? (
              <ApiMethodDetail key={selected.path} method={selected} />
            ) : selectedPath !== null ? (
              <ErrorBox
                variant="warning"
                message={t('system.apiExplorer.unknownMethod', { method: selectedPath })}
              />
            ) : (
              <EmptyState
                icon={MousePointerClick}
                title={t('system.apiExplorer.pickTitle')}
                description={t('system.apiExplorer.pickDescription')}
              />
            )}
          </div>
        </div>
      )}
    </AdminPage>
  )
}
