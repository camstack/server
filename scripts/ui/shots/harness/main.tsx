/**
 * `ui:shots` entry — the admin-ui `main.tsx` (the `/sso-complete` landing page
 * included, so an OAuth outcome can be shot) plus the harness switches read from
 * the URL:
 *   ?fx=<area,area|all>   fixture areas (scripts/ui/shots/fixtures/)
 *   ?theme=light|dark     the theme provider's stored mode
 * Both are kept in sessionStorage so in-app navigation keeps them.
 */
import * as Sdk from '@camstack/sdk'
import * as Types from '@camstack/types'
import * as UiLibrary from '@camstack/ui-library'
import { createRoot } from 'react-dom/client'

declare global {
  interface Window {
    __camstackUiLibrary: typeof UiLibrary
    __camstackSdk: typeof Sdk
    __camstackTypes: typeof Types
  }
}
window.__camstackUiLibrary = UiLibrary
window.__camstackSdk = Sdk
window.__camstackTypes = Types

const params = new URLSearchParams(window.location.search)
for (const key of ['fx', 'theme'] as const) {
  const v = params.get(key)
  if (v) sessionStorage.setItem(`ui-shots:${key}`, v)
}
localStorage.setItem('camstack-theme-mode', sessionStorage.getItem('ui-shots:theme') ?? 'light')
localStorage.setItem('camstack:sidebar-collapsed-groups', '[]')

// After the storage writes: the theme provider and the sidebar read them at import.
await import('./harness.css')
await import('@admin/i18n')
const { App } = await import('@admin/App')
const { mountSsoComplete } = await import('@admin/pages/SsoComplete')
const root = document.getElementById('root')
if (root === null) throw new Error('ui:shots: #root missing')
if (window.location.pathname === '/sso-complete') {
  mountSsoComplete(createRoot(root))
} else if (window.location.pathname.startsWith('/bosch-signin')) {
  const { BoschFormsPreview } = await import('./bosch-forms')
  createRoot(root).render(<BoschFormsPreview />)
} else {
  createRoot(root).render(<App />)
}
