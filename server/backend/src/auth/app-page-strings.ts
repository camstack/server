/**
 * Every word the hub's app landing pages show (D858), in both languages, and
 * the one rule that picks the language.
 *
 * The pages (`app-confirm-page.ts`, `app-passkey-page.ts`, `app-refused-route.ts`,
 * the OAuth2 consent page) hold NO prose of their own: they ask {@link appStrings}.
 * A key present in one locale and not the other is a compile error AND a spec
 * failure; a page that renders an English literal is a spec failure
 * (`app-page-strings.spec.ts`).
 *
 * Language choice ({@link resolveAppPageLang}): the `lang` the app sent
 * (allow-listed) wins; else the first supported tag of `Accept-Language`
 * (`it*` -> `it`); else English. Neither input is ever reflected into a page.
 */
import {
  APP_START_REFUSAL_MESSAGES,
  type AppPageLang,
  type AppStartRefusal,
  parseAppPageLang,
} from '@camstack/types'

export type { AppPageLang }

export const APP_PAGE_DEFAULT_LANG: AppPageLang = 'en'

/** The text of a page script, delivered as `data-s-*` attributes so the script itself stays constant (and its CSP hash too). */
export interface AppPageScriptStrings {
  readonly confirmExpired: string
  readonly passkeyUnsupported: string
  readonly passkeyUnavailable: string
  readonly passkeyCancelled: string
  readonly signInFailed: string
}

export interface AppPageStrings {
  readonly confirm: {
    readonly title: string
    readonly heading: string
    /** Two halves around the bold username: `before` + username + `after`. */
    readonly signedInAsBefore: string
    readonly signedInAsAfter: string
    readonly hint: string
    readonly continueLabel: string
    readonly cancel: string
    readonly noscript: string
  }
  readonly confirmExpired: {
    readonly title: string
    readonly body: string
    readonly hint: string
  }
  readonly passkey: {
    readonly title: string
    readonly heading: string
    readonly body: string
    readonly button: string
    readonly cancel: string
    readonly noscript: string
  }
  readonly refused: {
    readonly title: string
    readonly hint: string
    readonly generic: string
    readonly reasons: Readonly<Record<AppStartRefusal, string>>
  }
  readonly consent: {
    readonly titlePrefix: string
    readonly headingPrefix: string
    readonly signedInAs: string
    readonly grantPrefix: string
    readonly sendingTo: string
    readonly allow: string
    readonly deny: string
  }
  readonly script: AppPageScriptStrings
}

const EN: AppPageStrings = {
  confirm: {
    title: 'Sign in the CamStack app',
    heading: 'Sign in the CamStack app?',
    signedInAsBefore: 'The CamStack app on this device will be signed in as ',
    signedInAsAfter: '.',
    hint: 'Continue only if you just started this from the CamStack app.',
    continueLabel: 'Continue',
    cancel: 'Cancel',
    noscript: 'JavaScript is required to continue.',
  },
  confirmExpired: {
    title: 'Confirmation expired',
    body: 'This sign-in confirmation is no longer valid.',
    hint: 'Close this window and start the sign-in again from the app.',
  },
  passkey: {
    title: 'Sign in with a passkey',
    heading: 'Sign in to CamStack',
    body: 'Use a passkey saved on this device to sign in to the CamStack app.',
    button: 'Sign in with a passkey',
    cancel: 'Cancel',
    noscript: 'JavaScript is required to use a passkey.',
  },
  refused: {
    title: 'Sign-in request refused',
    hint: 'Close this window and try again from the app.',
    generic: 'The sign-in request was refused.',
    reasons: APP_START_REFUSAL_MESSAGES,
  },
  consent: {
    titlePrefix: 'CamStack · Authorize ',
    headingPrefix: 'Authorize ',
    signedInAs: 'Signed in as ',
    grantPrefix: 'This will grant: ',
    sendingTo: 'Sending the authorization to ',
    allow: 'Allow',
    deny: 'Deny',
  },
  script: {
    confirmExpired: 'This confirmation expired. Start the sign-in again from the app.',
    passkeyUnsupported: 'This browser cannot use passkeys.',
    passkeyUnavailable: 'Passkeys are not available.',
    passkeyCancelled: 'The passkey request was cancelled.',
    signInFailed: 'Sign-in failed. Try again.',
  },
}

const IT: AppPageStrings = {
  confirm: {
    title: "Accedi all'app CamStack",
    heading: "Accedere all'app CamStack?",
    signedInAsBefore: "L'app CamStack su questo dispositivo accederà come ",
    signedInAsAfter: '.',
    hint: "Continua solo se hai appena avviato l'operazione dall'app CamStack.",
    continueLabel: 'Continua',
    cancel: 'Annulla',
    noscript: 'Per continuare serve JavaScript.',
  },
  confirmExpired: {
    title: 'Conferma scaduta',
    body: 'Questa conferma di accesso non è più valida.',
    hint: "Chiudi questa finestra e riavvia l'accesso dall'app.",
  },
  passkey: {
    title: 'Accedi con una passkey',
    heading: 'Accedi a CamStack',
    body: "Usa una passkey salvata su questo dispositivo per accedere all'app CamStack.",
    button: 'Accedi con una passkey',
    cancel: 'Annulla',
    noscript: 'Per usare una passkey serve JavaScript.',
  },
  refused: {
    title: 'Richiesta di accesso rifiutata',
    hint: "Chiudi questa finestra e riprova dall'app.",
    generic: 'La richiesta di accesso è stata rifiutata.',
    reasons: {
      'bad-challenge': 'La richiesta di accesso non ha una sfida PKCE valida (S256).',
      'bad-challenge-method': 'È supportato solo il metodo PKCE S256.',
      'bad-state': 'La richiesta di accesso non ha uno state valido.',
      'bad-purpose': 'La richiesta di accesso indica uno scopo sconosciuto.',
      'bad-redirect':
        'La richiesta di accesso indica un indirizzo di ritorno che questo hub non accetta.',
      'combined-flow':
        "L'accesso dell'app non può essere combinato con il collegamento o con un popup.",
    },
  },
  consent: {
    titlePrefix: 'CamStack · Autorizza ',
    headingPrefix: 'Autorizza ',
    signedInAs: 'Accesso eseguito come ',
    grantPrefix: 'Concederà: ',
    sendingTo: "Invio dell'autorizzazione a ",
    allow: 'Consenti',
    deny: 'Nega',
  },
  script: {
    confirmExpired: "Questa conferma è scaduta. Riavvia l'accesso dall'app.",
    passkeyUnsupported: 'Questo browser non supporta le passkey.',
    passkeyUnavailable: 'Le passkey non sono disponibili.',
    passkeyCancelled: 'La richiesta della passkey è stata annullata.',
    signInFailed: 'Accesso non riuscito. Riprova.',
  },
}

export const APP_PAGE_STRINGS: Readonly<Record<AppPageLang, AppPageStrings>> = { en: EN, it: IT }

export function appStrings(lang: AppPageLang): AppPageStrings {
  return APP_PAGE_STRINGS[lang]
}

/** The first supported language of an `Accept-Language` value (by q, then order), or `undefined`. */
export function langFromAcceptLanguage(
  header: string | readonly string[] | undefined,
): AppPageLang | undefined {
  const value = typeof header === 'string' ? header : header?.join(',')
  if (value === undefined || value.length > 512) return undefined
  const ranked = value
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params
        .map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p)?.[1])
        .find((m) => m !== undefined)
      const weight = q === undefined ? 1 : Number.parseFloat(q)
      return { primary: tag.trim().toLowerCase().split('-')[0] ?? '', weight, index }
    })
    .filter((t) => Number.isFinite(t.weight) && t.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
  for (const { primary } of ranked) {
    const lang = parseAppPageLang(primary)
    if (lang !== undefined) return lang
  }
  return undefined
}

/** The page language: the app's `lang` (allow-listed), else `Accept-Language`, else English. */
export function resolveAppPageLang(input: {
  readonly lang?: unknown
  readonly acceptLanguage?: string | readonly string[]
}): AppPageLang {
  return (
    parseAppPageLang(input.lang) ??
    langFromAcceptLanguage(input.acceptLanguage) ??
    APP_PAGE_DEFAULT_LANG
  )
}
