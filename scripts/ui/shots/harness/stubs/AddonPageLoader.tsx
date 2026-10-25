/**
 * Harness stand-in: an addon page (`/addon/<x>`) renders from the workspace
 * source `packages/addon-<x>/src/page.tsx` instead of a Module Federation
 * remote, with the fixture-backed tRPC client — inside the REAL loading /
 * crash frame (`AddonPageBoundary`). `?ui-shots-pending` keeps the page
 * suspended forever, to shoot the loading state.
 */
import { type ComponentType, lazy } from 'react'
import { AddonPageBoundary } from '@admin/layouts/AddonPageFrame'
import { useNavigate, useParams } from 'react-router-dom'
import type { AddonPageInfo as ServerAddonPageInfo } from '@camstack/types'
import pages from 'virtual:ui-shots-addon-pages'
import { fakeClient } from './transport'

export interface AddonPageInfo {
  readonly id: string
  readonly addonId: string
  readonly label: string
  readonly icon: string
  readonly path: string
  readonly remoteName: string
  readonly bundle: string
  readonly bundleUrl: string
  readonly section?: string
  readonly sectionLabel?: string
}

export function flattenPages(raw: readonly ServerAddonPageInfo[]): readonly AddonPageInfo[] {
  return (raw ?? []).map((item) => ({
    id: item.page.id,
    addonId: item.addonId,
    label: item.page.label,
    icon: item.page.icon,
    path: item.page.path,
    remoteName: item.page.remoteName,
    bundle: item.page.bundle,
    bundleUrl: '',
    section: item.page.section,
    sectionLabel: item.page.sectionLabel,
  }))
}

interface PageProps {
  readonly trpc: unknown
  readonly theme: { readonly isDark: boolean }
  readonly navigate: (to: string) => void
}
type PageModule = { default: ComponentType<PageProps> }

const NeverLoads = lazy(() => new Promise<PageModule>(() => undefined))

const loaded = new Map<string, ComponentType<PageProps>>()
function pageFor(key: string): ComponentType<PageProps> | null {
  const importer = (pages as Record<string, () => Promise<PageModule>>)[key]
  if (importer === undefined) return null
  const cached = loaded.get(key)
  if (cached) return cached
  const C = lazy(importer)
  loaded.set(key, C)
  return C
}

export function AddonPageLoader() {
  const { pagePath } = useParams()
  const navigate = useNavigate()
  const pending = new URLSearchParams(window.location.search).has('ui-shots-pending')
  const Page = pending ? NeverLoads : pageFor(pagePath ?? '')
  if (Page === null)
    return <div className="p-6 text-sm">ui:shots: no workspace page for {pagePath}</div>
  return (
    <AddonPageBoundary pageKey={pagePath ?? ''}>
      <Page
        trpc={fakeClient()}
        theme={{ isDark: document.documentElement.classList.contains('dark') }}
        navigate={navigate}
      />
    </AddonPageBoundary>
  )
}
