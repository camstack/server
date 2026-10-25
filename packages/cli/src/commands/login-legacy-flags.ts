/**
 * `camstack login --admin` / `--admin-days` were removed (D895): there is one
 * login and one token, and the permissions follow the account. Old scripts still
 * pass them, so they stay parseable — a strict parse would abort the login — and
 * each one present earns a one-line warning instead of being ignored in silence.
 */
import type { ParseArgsConfig } from 'node:util'

type LoginOptions = NonNullable<ParseArgsConfig['options']>

/** Parsed `login` values, as `parseArgs` returns them. */
export type LoginFlagValues = Readonly<Record<string, string | boolean | undefined>>

export const LEGACY_LOGIN_FLAG_OPTIONS = {
  admin: { type: 'boolean' },
  'admin-days': { type: 'string' },
} as const satisfies LoginOptions

const LEGACY_LOGIN_FLAG_MESSAGES: Readonly<Record<keyof typeof LEGACY_LOGIN_FLAG_OPTIONS, string>> =
  {
    admin:
      '--admin is ignored: one login, one token — drop --admin (admin rights follow your account).',
    'admin-days':
      '--admin-days is ignored: one login, one token — drop --admin-days (the session renews itself).',
  }

/** One warning line per legacy flag present in `values`, in a stable order. */
export function legacyLoginFlagWarnings(values: LoginFlagValues): readonly string[] {
  const names = Object.keys(LEGACY_LOGIN_FLAG_MESSAGES).filter(isLegacyFlagName)
  return names
    .filter((name) => values[name] !== undefined)
    .map((name) => LEGACY_LOGIN_FLAG_MESSAGES[name])
}

function isLegacyFlagName(name: string): name is keyof typeof LEGACY_LOGIN_FLAG_OPTIONS {
  return name in LEGACY_LOGIN_FLAG_OPTIONS
}
