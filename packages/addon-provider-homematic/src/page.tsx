/// <reference types="vite/client" />
import './index.css'
import { useMemo, type ReactNode } from 'react'
import {
  EmptyState,
  ErrorBox,
  mountAddonPage,
  SectionedPage,
  Select,
  Skeleton,
  useUrlQueryParam,
  type AddonPageProps,
} from '@camstack/ui-library'
import { Plug } from 'lucide-react'
import { z } from 'zod'
import { CcuListItemSchema } from './ccu/ccu-schemas.js'
import { useT } from './i18n/index.js'
import { CcuDevicesTab } from './ui/CcuDevicesTab.js'
import { CcuHeatingTab } from './ui/CcuHeatingTab.js'
import { CcuOverviewTab } from './ui/CcuOverviewTab.js'
import type { CcuTrpc } from './ui/ccu-client.js'
import { useCcuData } from './ui/use-ccu-data.js'

const CcuListSchema = z.array(CcuListItemSchema)
const NO_INPUT = {}

/**
 * Homematic CCU management — federated Administration page. One CCU at a time
 * (`?ccu=`), one tab per task (`?tab=`). Every CCU write asks the operator first.
 */
export default function HomematicCcuPage(props: AddonPageProps) {
  const trpc: CcuTrpc = props.trpc
  const { t } = useT()
  const [ccuParam, setCcuParam] = useUrlQueryParam('ccu')
  const [tabParam, setTabParam] = useUrlQueryParam('tab')
  const list = useCcuData(trpc, 'listCcus', NO_INPUT, CcuListSchema)

  const ccus = list.data
  const selected = useMemo(() => {
    if (ccus === undefined || ccus.length === 0) return null
    return (
      ccus.find((ccu) => ccu.integrationId === ccuParam) ??
      ccus.find((ccu) => ccu.connected) ??
      ccus[0] ??
      null
    )
  }, [ccus, ccuParam])

  const body = (content: ReactNode): ReactNode => {
    if (list.error !== null) {
      return <ErrorBox title={t('page.loadFailed')} message={list.error} onRetry={list.reload} />
    }
    if (ccus === undefined) return <Skeleton className="h-32 w-full" />
    if (selected === null) {
      return <EmptyState title={t('page.noCcu')} description={t('page.noCcuHint')} />
    }
    if (!selected.connected) {
      return (
        <EmptyState
          title={t('page.notConnected', { name: selected.name })}
          description={t('page.notConnectedHint')}
        />
      )
    }
    return content
  }

  const integrationId = selected?.integrationId ?? ''
  return (
    <SectionedPage
      icon={Plug}
      title={t('page.title')}
      subtitle={selected === null ? t('page.subtitle') : selected.name}
      defaultSection="overview"
      sectionsLabel={t('page.sectionsLabel')}
      activeSection={tabParam ?? 'overview'}
      onSectionChange={(id) => setTabParam(id === 'overview' ? null : id)}
      actions={
        ccus !== undefined && ccus.length > 1 ? (
          <Select
            aria-label={t('page.ccuPicker')}
            value={selected?.integrationId ?? ''}
            onChange={(event) => setCcuParam(event.target.value)}
            options={ccus.map((ccu) => ({ value: ccu.integrationId, label: ccu.name }))}
          />
        ) : undefined
      }
      sections={[
        {
          id: 'overview',
          label: t('page.tabOverview'),
          content: body(<CcuOverviewTab trpc={trpc} integrationId={integrationId} />),
        },
        {
          id: 'devices',
          label: t('page.tabDevices'),
          content: body(<CcuDevicesTab trpc={trpc} integrationId={integrationId} />),
        },
        {
          id: 'heating',
          label: t('page.tabHeating'),
          content: body(<CcuHeatingTab trpc={trpc} integrationId={integrationId} />),
        },
      ]}
    />
  )
}

if (import.meta.env?.DEV && typeof document !== 'undefined' && document.getElementById('root')) {
  mountAddonPage(HomematicCcuPage, { title: 'Homematic CCU' })
}
