/**
 * System → Data → Secrets (`/system/data?tab=secrets`, formerly
 * `/system/settings?tab=secrets`): a ready keychain with stored values in the
 * three usage states, a pending reset re-entry notice and an audit trail.
 */
import { defineFixtures } from './_define'
import { H, NOW } from './_time'

const SOURCE = {
  kind: 'default-file',
  path: '/data/.keychain/master.key',
  sharesBackupWithDatabase: true,
}

const RESET = {
  id: 'r1',
  at: NOW - 30 * H,
  actor: 'trigger-file',
  lockedReason: 'wrong-key',
  archived: 3,
  archivedCollection: 'keychain:secrets-orphaned-1',
  archivedKeysCollection: 'keychain:keys-orphaned-1',
  clearedSettingsKeys: [],
  acknowledgedAt: null,
}

const secret = (owner: string, fieldPath: string, usage: string) => ({
  ref: `secret://${owner}/global/${fieldPath}`,
  owner,
  scope: 'global',
  fieldPath,
  version: 1,
  createdAt: NOW - 40 * H,
  updatedAt: NOW - 2 * H,
  updatedBy: `addon:${owner}`,
  lastReadAt: null,
  usage,
})

const SECRETS = [
  secret('cloudflare-tunnel', 'customApiToken', 'in-use'),
  secret('notifiers', 'targets.telegram.botToken', 'orphan'),
  secret('auth-oidc', 'providers.example.clientSecret', 'orphan'),
  secret('provider-homeassistant', 'longLivedAccessToken', 'unknown'),
]

export default defineFixtures({
  area: 'keychain',
  description: 'Secrets tab: keychain status, stored values, reset notice and audit',
  handlers: {
    'keychainAdmin.status': {
      keychain: { state: 'ready' },
      keySource: SOURCE,
      configuredSource: SOURCE,
      fingerprint: '0123456789abcdef',
      activeKeyId: 'k1',
      rotationPending: false,
      retiredWraps: 0,
      recoveryKeyDownloadedAt: null,
      secretCount: SECRETS.length,
      lastReset: RESET,
    },
    'keychainAdmin.listSecrets': SECRETS,
    'keychainAdmin.listAudit': Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`,
      at: NOW - i * H,
      action: 'reveal',
      actor: 'user:admin',
      ref: `secret://example/global/field-${i}`,
      detail: null,
    })),
    'keychainAdmin.resetReport': { reset: RESET, pendingReentry: [SECRETS[0]] },
  },
})
