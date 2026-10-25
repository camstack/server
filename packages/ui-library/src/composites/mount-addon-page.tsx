/**
 * mountAddonPage — one-liner to mount an addon page in dev mode.
 *
 * Handles everything: CSS import, React DOM mount, DevShell (login + theme + tRPC),
 * and wiring props in the standard AddonPageProps format.
 *
 * Usage in the addon's dev-shell.tsx:
 * ```tsx
 * import { mountAddonPage } from '@camstack/ui'
 * import MyPage from './page'
 * mountAddonPage(MyPage)
 * ```
 *
 * Or with options:
 * ```tsx
 * mountAddonPage(MyPage, { serverUrl: 'https://localhost:4443', title: 'My Addon' })
 * ```
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { DevShell } from './dev-shell'
import type { AddonPageProps } from './addon-page-props'

export interface MountAddonPageOptions {
  /** Backend server URL (default: 'https://localhost:4443') */
  serverUrl?: string
  /** Title shown in the dev toolbar */
  title?: string
  /** Root element ID (default: 'root') */
  rootId?: string
}

/**
 * Mount an addon page component with the full dev shell.
 *
 * @param PageComponent - The addon page component (must accept AddonPageProps)
 * @param options - Configuration options
 */
export function mountAddonPage(
  PageComponent: (props: AddonPageProps) => React.ReactNode,
  options: MountAddonPageOptions = {},
): void {
  const { serverUrl = 'https://localhost:4443', title, rootId = 'root' } = options

  const root = document.getElementById(rootId)
  if (!root) {
    console.error(`[mountAddonPage] Element #${rootId} not found`)
    return
  }

  createRoot(root).render(
    createElement(DevShell, {
      serverUrl,
      title,
      children: ({ trpc, theme }) =>
        createElement(PageComponent, {
          trpc,
          theme: { isDark: theme.resolvedMode === 'dark' },
          navigate: (path: string) => {
            console.log('[dev] navigate:', path)
          },
        }),
    }),
  )
}
