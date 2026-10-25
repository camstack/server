/**
 * The one shell of every standalone page the hub renders for a native app
 * sign-in (D858): the passkey page, the confirmation page, the refusal pages.
 *
 * These pages are server-rendered HTML with no admin-ui bundle and a strict
 * CSP, so they cannot borrow the admin login's React components - but they must
 * not look like a different product either. Everything visual lives HERE and
 * nowhere else:
 *
 *  - the colours, radii, spacing and font stack are GENERATED from the theme
 *    the admin UI is built on (`@camstack/ui-library/theme/tokens`) - no hex is
 *    typed in this file, so a theme change reaches these pages by itself;
 *  - the card, primary button, cancel link, error line and muted hint repeat the
 *    admin login page's look (`Login.tsx`: `rounded-xl border bg-surface p-6`,
 *    `bg-primary rounded-lg` button, `bg-danger/10` error);
 *  - the stylesheet is ONE inline `<style>` and the CSP pins it by the SHA-256
 *    of the very string that is served, computed at module load - there is no
 *    hand-pasted hash that can fall out of step with the CSS.
 */
import { createHash } from 'node:crypto'
import type { AppPageLang } from '@camstack/types'
import { defaultTheme, themeToRootCss } from '@camstack/ui-library/theme/tokens'

/** The brand mark and wordmark, one per colour scheme (the files under `addon-admin-ui/public/brand`). */
const LOGO_DARK =
  '<svg class="logo logo-dark" role="img" aria-label="CamStack" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 48" fill="none"><g transform="translate(4, 2) scale(0.68)"><rect x="8" y="28" width="48" height="28" rx="6" fill="#292524"/><rect x="12" y="16" width="40" height="28" rx="6" fill="#44403c"/><rect x="16" y="4" width="32" height="28" rx="6" fill="#f59e42"/><circle cx="32" cy="18" r="8" fill="#0c0a09" opacity="0.3"/><circle cx="32" cy="18" r="5" fill="#0c0a09" opacity="0.2"/><circle cx="32" cy="18" r="2.5" fill="#fafaf9" opacity="0.8"/></g><text x="52" y="31" font-family="system-ui, -apple-system, sans-serif" font-size="26" font-weight="700" letter-spacing="-0.5" fill="#fafaf9">Cam<tspan fill="#f59e42">Stack</tspan></text></svg>'
const LOGO_LIGHT =
  '<svg class="logo logo-light" role="img" aria-label="CamStack" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 48" fill="none"><g transform="translate(4, 2) scale(0.68)"><rect x="8" y="28" width="48" height="28" rx="6" fill="#d6d3d1"/><rect x="12" y="16" width="40" height="28" rx="6" fill="#a8a29e"/><rect x="16" y="4" width="32" height="28" rx="6" fill="#e67e22"/><circle cx="32" cy="18" r="8" fill="#fafaf9" opacity="0.3"/><circle cx="32" cy="18" r="5" fill="#fafaf9" opacity="0.2"/><circle cx="32" cy="18" r="2.5" fill="#1c1917" opacity="0.7"/></g><text x="52" y="31" font-family="system-ui, -apple-system, sans-serif" font-size="26" font-weight="700" letter-spacing="-0.5" fill="#1c1917">Cam<tspan fill="#e67e22">Stack</tspan></text></svg>'

/** The logo markup, exposed so a spec can hold it against the brand files. */
export const APP_PAGE_LOGOS: { readonly dark: string; readonly light: string } = {
  dark: LOGO_DARK,
  light: LOGO_LIGHT,
}

/**
 * Component rules, written against the token variables. Sizes mirror the admin
 * login page (Tailwind `text-sm`/`text-xs`, `rounded-xl`, `p-6`, `py-2.5`),
 * with a 44 px touch target for the phone this opens on.
 */
const COMPONENT_CSS = [
  '*,*::before,*::after{box-sizing:border-box}',
  `html{background:var(--color-background)}`,
  `body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:max(var(--spacing-xl),env(safe-area-inset-top)) max(var(--spacing-xl),env(safe-area-inset-right)) max(var(--spacing-xl),env(safe-area-inset-bottom)) max(var(--spacing-xl),env(safe-area-inset-left));background:var(--color-background);color:var(--color-foreground);font-family:var(--font-family);font-size:14px;line-height:20px;-webkit-text-size-adjust:100%}`,
  `main{width:100%;max-width:24rem}`,
  `.brand{display:flex;justify-content:center;margin-bottom:var(--spacing-3xl)}`,
  `.logo{height:3rem;width:auto}`,
  `.logo-dark{display:none}`,
  `@media (prefers-color-scheme:dark){.logo-dark{display:block}.logo-light{display:none}}`,
  `.card{display:flex;flex-direction:column;gap:var(--spacing-xl);padding:var(--spacing-2xl);border:1px solid var(--color-border);border-radius:var(--radius-xl);background:var(--color-surface);box-shadow:0 20px 25px -5px rgb(0 0 0/.1),0 8px 10px -6px rgb(0 0 0/.1)}`,
  `.card h1{margin:0;font-size:16px;line-height:22px;font-weight:600;text-align:center;color:var(--color-foreground)}`,
  `.card p{margin:0;color:var(--color-foreground-muted)}`,
  `.card strong{color:var(--color-foreground);font-weight:600;overflow-wrap:anywhere}`,
  `.card .hint{font-size:12px;line-height:16px;color:var(--color-foreground-subtle)}`,
  `.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;padding:10px 16px;border:1px solid transparent;border-radius:var(--radius-lg);background:var(--color-primary);color:var(--color-primary-foreground);font:inherit;font-weight:600;text-decoration:none;cursor:pointer;box-shadow:0 4px 6px -1px color-mix(in srgb,var(--color-primary) 20%,transparent)}`,
  `.btn:hover{background:color-mix(in srgb,var(--color-primary) 90%,transparent)}`,
  `.btn:disabled{opacity:.5;cursor:not-allowed;box-shadow:none}`,
  `.btn.secondary{background:var(--color-background);color:var(--color-foreground);border-color:var(--color-border);box-shadow:none}`,
  `.btn.secondary:hover{background:var(--color-surface-hover)}`,
  `.link{display:block;text-align:center;padding:var(--spacing-md);font-size:12px;line-height:16px;color:var(--color-foreground-subtle);text-decoration:none}`,
  `.link:hover{color:var(--color-foreground)}`,
  `.error{padding:8px 12px;border:1px solid color-mix(in srgb,var(--color-danger) 20%,transparent);border-radius:var(--radius-md);background:color-mix(in srgb,var(--color-danger) 10%,transparent);color:var(--color-danger);font-size:12px;line-height:16px}`,
  `.card p.error{color:var(--color-danger)}`,
  `.error:empty{display:none}`,
  `.btn:focus-visible,.link:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}`,
  `code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}`,
  `.field{display:flex;flex-direction:column;gap:var(--spacing-md)}`,
  `.field label{font-size:12px;line-height:16px;font-weight:500;color:var(--color-foreground-muted)}`,
  `input[type=url],input[type=text]{width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-background);color:var(--color-foreground);font:inherit}`,
  `input[type=url]:focus-visible,input[type=text]:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}`,
  `form{display:contents}`,
  `.actions{display:flex;flex-direction:column;gap:var(--spacing-md)}`,
].join('')

/** The one stylesheet, as served: the generated tokens followed by the component rules. */
export const APP_PAGE_STYLE: string = `${themeToRootCss(defaultTheme)}${COMPONENT_CSS}`

const sha256Source = (text: string): string =>
  `'sha256-${createHash('sha256').update(text).digest('base64')}'`

export interface AppPageCspOptions {
  /** The page's one inline script, exactly as it is rendered; omitted means the page runs nothing. */
  readonly script?: string
  /** `true` when the page POSTs a form to its own address (the consent screen). */
  readonly formToSelf?: boolean
}

/**
 * The CSP for a page rendered by {@link renderAppPage}: the inline style and
 * (when there is one) the inline script by hash, same-origin requests only, no
 * framing, no base rewrite. The hashes are computed from the strings the page
 * is built from, so they cannot disagree with it.
 */
export function appPageCsp(options: AppPageCspOptions = {}): string {
  return [
    "default-src 'none'",
    ...(options.script === undefined ? [] : [`script-src ${sha256Source(options.script)}`]),
    `style-src ${sha256Source(APP_PAGE_STYLE)}`,
    ...(options.script === undefined ? [] : ["connect-src 'self'"]),
    "base-uri 'none'",
    `form-action ${options.formToSelf === true ? "'self'" : "'none'"}`,
    "frame-ancestors 'none'",
  ].join('; ')
}

/** Escapes text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

export interface AppPageInput {
  /** The page language: `<html lang>` and the words the caller chose (D858). */
  readonly lang: AppPageLang
  /** The `<title>`; plain text, escaped here. */
  readonly title: string
  /** The card's heading; plain text, escaped here. */
  readonly heading: string
  /** HTML inside the card, below the heading. Built from the helpers below, escaped by the caller. */
  readonly body: string
  /** The one inline script; its CSP hash is {@link appPageCsp}`({ script })`. */
  readonly script?: string
  /**
   * Text the inline script writes, as `data-s-<key>` attributes on `<body>` -
   * the script reads them, so it stays constant across languages and its CSP
   * hash is the same per build, not per language. Values are escaped here.
   */
  readonly scriptStrings?: Readonly<Record<string, string>>
  /** Sent as `<meta name="referrer" content="no-referrer">` - pages whose URL carries a secret. */
  readonly noReferrer?: boolean
}

/** A full page: doctype, viewport (with safe-area fit), tokens, logo, a card holding `body`. */
export function renderAppPage(input: AppPageInput): string {
  const referrer = input.noReferrer === true ? '<meta name="referrer" content="no-referrer">' : ''
  const script = input.script === undefined ? '' : `<script>${input.script}</script>`
  const strings = Object.entries(input.scriptStrings ?? {})
    .map(([key, value]) => ` data-s-${key}="${escapeHtml(value)}"`)
    .join('')
  return `<!doctype html><html lang="${input.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark">${referrer}<title>${escapeHtml(input.title)}</title><style>${APP_PAGE_STYLE}</style></head><body${strings}><main><div class="brand">${LOGO_DARK}${LOGO_LIGHT}</div><div class="card"><h1>${escapeHtml(input.heading)}</h1>${input.body}</div></main>${script}</body></html>`
}

/** A paragraph of the card (`text` is escaped). */
export const appParagraph = (text: string): string => `<p>${escapeHtml(text)}</p>`

/** A smaller, muted paragraph (`text` is escaped). */
export const appHint = (text: string): string => `<p class="hint">${escapeHtml(text)}</p>`

/** The primary button; `attributes` is trusted markup (already escaped), `label` is escaped. */
export const appButton = (label: string, attributes: string): string =>
  `<button class="btn" type="button" ${attributes}>${escapeHtml(label)}</button>`

/** The error line a script fills in; empty it renders nothing. */
export const appErrorLine = (id: string): string => `<p class="error" id="${id}" role="alert"></p>`

/** A submit button of a form (`name`/`value` are escaped); `secondary` is the outlined, non-default choice. */
export const appSubmitButton = (
  label: string,
  name: string,
  value: string,
  secondary = false,
): string =>
  `<button class="${secondary ? 'btn secondary' : 'btn'}" type="submit" name="${escapeHtml(name)}" value="${escapeHtml(value)}">${escapeHtml(label)}</button>`

/** A hidden form field (`name`/`value` are escaped). */
export const appHiddenField = (name: string, value: string): string =>
  `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`

/** The quiet link under the actions (Cancel); `href` is escaped here. */
export const appCancelLink = (href: string, label: string): string =>
  `<a class="link" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
