/**
 * Build-your-self — Automations / Scripts / Custom Device.
 *
 * Shell is library `SectionedPage` via `AdminSectionedPage` (OSD template).
 */
import { coreBlockSourceKind, type CoreBlock } from '@camstack/types'
import { Button, useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { Hammer, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { AdminSectionedPage } from '../components/AdminSectionedPage'
import { navChromeForPath } from '../lib/nav-items'
import { looksLikeAutomation } from './build/automation/recipe-from-code'
import { AutomationsTab } from './build/AutomationsTab'
import { CustomDeviceTab } from './build/CustomDeviceTab'
import { ScriptsTab } from './build/ScriptsTab'

const TABS = ['automations', 'scripts', 'custom-device'] as const
type BuildTab = (typeof TABS)[number]

function isTab(value: string | null): value is BuildTab {
  return value !== null && TABS.some((t) => t === value)
}

const BLOCKS_KEY = ['coreBlocks', 'list', 'build-counts'] as const
const EDITOR_OWNED = ['block', 'create'] as const

function countScripts(blocks: readonly CoreBlock[]): number {
  return blocks.filter((b) => coreBlockSourceKind(b) === 'code').length
}

function countAutomations(blocks: readonly CoreBlock[]): number {
  return blocks.filter((b) => looksLikeAutomation(b.code)).length
}

function withCount(label: string, count: number | null): string {
  return count === null ? label : `${label} (${String(count)})`
}

export function BuildPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: BuildTab = isTab(raw) ? raw : 'automations'
  const createRequested = params.get('create') === '1'

  const countsQuery = useQuery({
    queryKey: BLOCKS_KEY,
    refetchInterval: 5_000,
    queryFn: async (): Promise<readonly CoreBlock[]> => {
      const result = await system.trpcClient.coreBlocks.list.query({})
      return result.blocks
    },
  })
  const blocks = countsQuery.data
  const scriptCount = blocks === undefined ? null : countScripts(blocks)
  const automationCount = blocks === undefined ? null : countAutomations(blocks)

  const compositionsQuery = useQuery({
    queryKey: ['coreBlocks', 'listCompositions', 'build-counts'],
    refetchInterval: 10_000,
    queryFn: async () => system.trpcClient.coreBlocks.listCompositions.query({}),
  })
  const compositionCount =
    compositionsQuery.data?.state === 'loaded' ? compositionsQuery.data.views.length : null

  const openScripts = (blockId?: string): void => {
    setParams(
      (prev) => {
        const copy = new URLSearchParams(prev)
        copy.set('tab', 'scripts')
        copy.delete('create')
        if (blockId === undefined) copy.delete('block')
        else copy.set('block', blockId)
        return copy
      },
      { replace: true },
    )
  }

  const setAutomationsBlock = (blockId: string | null): void => {
    setParams(
      (prev) => {
        const copy = new URLSearchParams(prev)
        copy.set('tab', 'automations')
        copy.delete('create')
        if (blockId === null) copy.delete('block')
        else copy.set('block', blockId)
        return copy
      },
      { replace: true },
    )
  }

  const setScriptsBlock = (blockId: string | null): void => {
    setParams(
      (prev) => {
        const copy = new URLSearchParams(prev)
        copy.set('tab', 'scripts')
        copy.delete('create')
        if (blockId === null) copy.delete('block')
        else copy.set('block', blockId)
        return copy
      },
      { replace: true },
    )
  }

  const requestCreate = (): void => {
    setParams(
      (prev) => {
        const copy = new URLSearchParams(prev)
        copy.set('create', '1')
        copy.delete('block')
        return copy
      },
      { replace: true },
    )
  }

  const clearCreate = (): void => {
    setParams(
      (prev) => {
        const copy = new URLSearchParams(prev)
        copy.delete('create')
        return copy
      },
      { replace: true },
    )
  }

  const newLabel =
    tab === 'automations' ? 'New automation' : tab === 'scripts' ? 'New script' : 'New composition'

  const chrome = navChromeForPath('/build', { t, isAdmin: true }) ?? {
    icon: Hammer,
    title: t('nav.build', 'Build-your-self'),
  }

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      subtitle={t(
        'build.automationsScriptsAndComposedDevices',
        'Automations, scripts and composed devices — what this installation does on its own.',
      )}
      defaultSection="automations"
      sectionsLabel={`${chrome.title} sections`}
      fill
      actions={
        <Button type="button" onClick={requestCreate} data-testid="build-new">
          <Plus className="h-4 w-4" /> {newLabel}
        </Button>
      }
      sections={[
        {
          id: 'automations',
          label: withCount('Automations', automationCount),
          ownedParams: EDITOR_OWNED,
          content: (
            <AutomationsTab
              onOpenScripts={openScripts}
              initialBlockId={
                tab === 'automations' ? (params.get('block') ?? undefined) : undefined
              }
              onBlockIdChange={setAutomationsBlock}
              createRequested={tab === 'automations' && createRequested}
              onCreateConsumed={clearCreate}
            />
          ),
        },
        {
          id: 'scripts',
          label: withCount('Scripts', scriptCount),
          ownedParams: EDITOR_OWNED,
          content: (
            <ScriptsTab
              initialBlockId={tab === 'scripts' ? (params.get('block') ?? undefined) : undefined}
              onBlockIdChange={setScriptsBlock}
              createRequested={tab === 'scripts' && createRequested}
              onCreateConsumed={clearCreate}
            />
          ),
        },
        {
          id: 'custom-device',
          label: withCount('Custom Device', compositionCount),
          ownedParams: EDITOR_OWNED,
          content: (
            <CustomDeviceTab
              createRequested={tab === 'custom-device' && createRequested}
              onCreateConsumed={clearCreate}
            />
          ),
        },
      ]}
    />
  )
}
