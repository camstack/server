import * as UiLibrary from '@camstack/ui-library'
import * as Sdk from '@camstack/sdk'
import * as Types from '@camstack/types'

// Module Federation host globals — `vite.config.ts` skips the
// `@module-federation/vite` host plugin in dev mode (it conflicts with
// Vite's CJS dep prebundler), so `ensureMfHostInit()` (in ui-library)
// has to register the workspace `@camstack/*` packages against the
// host's already-loaded module instances at runtime. Reading those
// modules through globals avoids re-bundling them inside ui-library
// solely for the federation-runtime registration. The npm-package
// shareds (react, react-dom, @tanstack/*, @trpc/*) are read directly
// via namespace imports inside `mf-runtime-init.ts` — no globals
// needed for those.
//
// Production builds: `@module-federation/vite`'s injected host
// bootstrap auto-registers shared instances; these globals become
// no-ops but stay set as a safety net.
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

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { isSsoCompletePath } from './lib/sso-popup'
import { routerBasename } from './lib/mount'
import { mountSsoComplete } from './pages/SsoComplete'
import './index.css'
import './i18n'

const root = createRoot(document.getElementById('root')!)
// A popup SSO return (D791) never boots the app: the completion page reads its
// fragment, hands the outcome back and closes.
if (isSsoCompletePath(window.location.pathname, routerBasename())) {
  mountSsoComplete(root)
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
