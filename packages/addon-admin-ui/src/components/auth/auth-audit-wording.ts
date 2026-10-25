/**
 * Human wording for the auth audit trail (`auth.listAuthAudit`). The actions
 * are the hub's `AUTH_AUDIT_ACTIONS`; an action this UI does not know yet is
 * shown by its name with its raw detail fields, never dropped.
 */
import { describeMethod, formatDateTime } from './session-client'
import i18n from '../../i18n/index'

export interface AuthAuditRecord {
  readonly id: string
  readonly at: number
  readonly action: string
  readonly userId?: string
  readonly ip?: string
  readonly detail?: Readonly<Record<string, string | number | boolean>>
}

export interface AuditWording {
  readonly title: string
  readonly details: readonly string[]
}

type Detail = NonNullable<AuthAuditRecord['detail']>

/** `auth.revokeCredentials` kinds, plural, for the bulk audit title. */
const BULK_NOUN_KEY: Readonly<Record<string, string>> = {
  'by-id': 'helpers.authAuditWording.bulkNoun.credential',
  'share-link': 'helpers.authAuditWording.bulkNoun.shareLink',
  'admin-token': 'helpers.authAuditWording.bulkNoun.adminToken',
  'login-session': 'helpers.authAuditWording.bulkNoun.loginSession',
}

function str(detail: Detail, key: string): string | null {
  const v = detail[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function tokenName(detail: Detail, tokenNameById: ReadonlyMap<string, string>): string {
  const id = str(detail, 'tokenId')
  return str(detail, 'name') ?? (id !== null ? tokenNameById.get(id) : undefined) ?? id ?? '?'
}

function present(values: readonly (string | null)[]): string[] {
  return values.filter((v): v is string => v !== null)
}

function prefixLine(detail: Detail): string | null {
  const prefix = str(detail, 'prefix')
  return prefix === null ? null : i18n.t('helpers.authAuditWording.prefix', { prefix })
}

export function describeAuditEvent(
  record: AuthAuditRecord,
  tokenNameById: ReadonlyMap<string, string>,
): AuditWording {
  const detail: Detail = record.detail ?? {}
  switch (record.action) {
    case 'admin-token-created': {
      const expiresAt = detail['expiresAt']
      return {
        title: i18n.t('helpers.authAuditWording.tokenCreated', {
          name: tokenName(detail, tokenNameById),
        }),
        details: present([
          prefixLine(detail),
          typeof expiresAt === 'number'
            ? i18n.t('helpers.authAuditWording.expires', { at: formatDateTime(expiresAt) })
            : null,
        ]),
      }
    }
    case 'admin-token-used': {
      const path = str(detail, 'path')
      return {
        title: i18n.t('helpers.authAuditWording.tokenUsed', {
          name: tokenName(detail, tokenNameById),
        }),
        details: present([
          prefixLine(detail),
          path === null ? null : i18n.t('helpers.authAuditWording.call', { path }),
        ]),
      }
    }
    case 'token-minted': {
      const expiresAt = detail['expiresAt']
      return {
        title: i18n.t('helpers.authAuditWording.tokenMinted', {
          name: tokenName(detail, tokenNameById),
        }),
        details: present([
          typeof expiresAt === 'number'
            ? i18n.t('helpers.authAuditWording.expires', { at: formatDateTime(expiresAt) })
            : null,
        ]),
      }
    }
    case 'token-revoked':
      return {
        title: i18n.t('helpers.authAuditWording.anyTokenRevoked', {
          name: tokenName(detail, tokenNameById),
        }),
        details: [],
      }
    case 'admin-token-revoked':
      return {
        title: i18n.t('helpers.authAuditWording.tokenRevoked', {
          name: tokenName(detail, tokenNameById),
        }),
        details: present([prefixLine(detail)]),
      }
    case 'credentials-revoked': {
      const kind = str(detail, 'kind') ?? 'credential'
      const revoked = detail['revoked']
      const skipped = detail['skipped']
      const nounKey = BULK_NOUN_KEY[kind]
      const noun = nounKey === undefined ? `${kind}s` : i18n.t(nounKey)
      return {
        title: i18n.t('helpers.authAuditWording.bulkRevoked', {
          n: typeof revoked === 'number' ? String(revoked) : '?',
          noun,
        }),
        details: present([
          typeof skipped === 'number' && skipped > 0
            ? i18n.t('helpers.authAuditWording.skipped', { count: skipped })
            : null,
          str(detail, 'ids') === null
            ? null
            : i18n.t('helpers.authAuditWording.ids', { ids: str(detail, 'ids') ?? '' }),
        ]),
      }
    }
    case 'second-factor-skipped': {
      const method = str(detail, 'method')
      const factors = str(detail, 'factors')
      return {
        title: i18n.t('helpers.authAuditWording.secondFactorSkipped'),
        details: present([
          method === null
            ? null
            : i18n.t('helpers.authAuditWording.signedInWith', { method: describeMethod(method) }),
          factors === null
            ? null
            : i18n.t('helpers.authAuditWording.skippedFactors', {
                factors: factors.split(',').join(', '),
              }),
        ]),
      }
    }
    default:
      return {
        title: record.action,
        details: Object.entries(detail).map(([k, v]) => `${k}: ${String(v)}`),
      }
  }
}
