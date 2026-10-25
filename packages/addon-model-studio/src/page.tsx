/// <reference types="vite/client" />
import './index.css'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  PageShell,
  Tabs,
  TabsList,
  TabsTrigger,
  mountAddonPage,
  useUrlQueryParam,
  type AddonPageProps,
} from '@camstack/ui-library'
import { Box } from 'lucide-react'
import { CatalogTab, parseCatalogSource, type CatalogSource } from './tabs/CatalogTab.js'
import { ImportTab } from './tabs/ImportTab.js'
import { InstalledTab } from './tabs/InstalledTab.js'
import { LogsTab } from './tabs/LogsTab.js'
import { OperationModalProvider } from './components/OperationModalProvider.js'
import { useT } from './i18n/index.js'
import type { UploadPrefill } from './tabs/PlusCatalogSourceSections.js'

// Catalog = CamStack/plugin catalog/plus catalog (plus catalog key lives under Catalog → plus catalog).
// Installed = inventory. Import = Custom. Logs = addon runner.
const TABS = [{ id: 'catalog' }, { id: 'installed' }, { id: 'import' }, { id: 'logs' }] as const

type TabId = (typeof TABS)[number]['id']

function parseTab(raw: string | null): TabId {
  if (raw === 'library') return 'installed'
  if (raw === 'convert' || raw === 'settings') return 'catalog'
  if (raw === 'import' || raw === 'catalog' || raw === 'installed' || raw === 'logs') return raw
  return 'catalog'
}

function tabDomId(id: TabId): string {
  return `model-studio-tab-${id}`
}

function panelDomId(id: TabId): string {
  return `model-studio-panel-${id}`
}

export default function ModelStudioPage({ trpc }: AddonPageProps) {
  const { t } = useT()
  const [tabParam, setTabParam] = useUrlQueryParam('tab')
  const [sourceParam, setSourceParam] = useUrlQueryParam('source')
  const activeTab = parseTab(tabParam)

  const catalogSource = parseCatalogSource(sourceParam)

  const [refreshKey, setRefreshKey] = useState(0)
  const [importPrefill, setImportPrefill] = useState<UploadPrefill | null>(null)
  const moveFocusToActive = useRef(false)

  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  const selectTab = useCallback(
    (id: TabId, moveFocus = false) => {
      setTabParam(id === 'catalog' ? null : id)
      if (id !== 'catalog' && sourceParam !== null) {
        // Catalog owns ?source= — clear it on other tabs (Installed keeps provider/type/node).
        if (id === 'import' || id === 'logs' || id === 'installed') {
          setSourceParam(null)
        }
      }
      if (moveFocus) moveFocusToActive.current = true
    },
    [setTabParam, setSourceParam, sourceParam],
  )

  const setCatalogSource = useCallback(
    (kind: CatalogSource) => {
      setSourceParam(kind === 'camstack' ? null : kind)
    },
    [setSourceParam],
  )

  useEffect(() => {
    if (!moveFocusToActive.current) return
    moveFocusToActive.current = false
    document.getElementById(tabDomId(activeTab))?.focus()
  }, [activeTab])

  useEffect(() => {
    if (tabParam === 'convert') setTabParam(null)
    if (tabParam === 'library') setTabParam('installed')
    // Legacy Settings → Catalog plus catalog (key lives there now).
    if (tabParam === 'settings') {
      setTabParam(null)
      setSourceParam('frigate')
    }
    // `source` only means something under Catalog; drop it everywhere else.
    if (activeTab !== 'catalog' && sourceParam !== null) setSourceParam(null)
    if (activeTab === 'catalog' && sourceParam === 'custom') {
      setTabParam('import')
      setSourceParam(null)
    }
  }, [tabParam, activeTab, sourceParam, setTabParam, setSourceParam])

  const onTabListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      const ids = TABS.map((t) => t.id)
      const idx = ids.indexOf(activeTab)
      if (idx < 0) return
      let next: TabId | undefined
      if (event.key === 'ArrowRight') next = ids[(idx + 1) % ids.length]
      else if (event.key === 'ArrowLeft') next = ids[(idx - 1 + ids.length) % ids.length]
      else if (event.key === 'Home') next = ids[0]
      else if (event.key === 'End') next = ids[ids.length - 1]
      if (next === undefined) return
      event.preventDefault()
      selectTab(next, true)
    },
    [activeTab, selectTab],
  )

  return (
    <OperationModalProvider>
      <PageShell icon={Box} title={t('page.title')}>
        <Tabs
          value={activeTab}
          onValueChange={(next) => {
            if (
              next === 'catalog' ||
              next === 'installed' ||
              next === 'import' ||
              next === 'logs'
            ) {
              selectTab(next)
            }
          }}
        >
          <TabsList aria-label={t('page.sections')} onKeyDown={onTabListKeyDown}>
            {TABS.map((tab) => (
              <TabsTrigger
                key={tab.id}
                id={tabDomId(tab.id)}
                value={tab.id}
                aria-controls={panelDomId(tab.id)}
              >
                {t(`page.tabs.${tab.id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div
          className="min-h-[400px]"
          role="tabpanel"
          id={panelDomId(activeTab)}
          aria-labelledby={tabDomId(activeTab)}
        >
          {activeTab === 'catalog' && (
            <CatalogTab
              trpc={trpc}
              refreshKey={refreshKey}
              source={catalogSource}
              onSourceChange={setCatalogSource}
              onRegistered={bumpRefresh}
              onPrefillUpload={(prefill) => {
                setImportPrefill(prefill)
                selectTab('import')
              }}
            />
          )}
          {activeTab === 'installed' && <InstalledTab trpc={trpc} refreshKey={refreshKey} />}
          {activeTab === 'import' && (
            <ImportTab
              trpc={trpc}
              onRegistered={bumpRefresh}
              initialPrefill={importPrefill}
              onPrefillConsumed={() => setImportPrefill(null)}
            />
          )}
          {activeTab === 'logs' && <LogsTab />}
        </div>
      </PageShell>
    </OperationModalProvider>
  )
}

if (import.meta.env?.DEV && document.getElementById('root')) {
  mountAddonPage(ModelStudioPage, { title: 'Model Studio' })
}
