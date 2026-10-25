/**
 * Local Auth Addon — owns user accounts, API keys, scoped tokens,
 * and local password authentication.
 *
 * Capabilities registered:
 *   - `auth-provider` (collection) — local password authentication
 *   - `user-management` (singleton) — user CRUD, API keys, scoped tokens
 *
 * This addon owns the OAuth grant MACHINERY (codes, sessions, refresh) but
 * declares no `oauth-integration` client of its own, and must not start: which
 * clients exist is integration-specific knowledge and belongs to the addon that
 * owns the integration (D101). `homeassistant` moved to `homeassistant-export`;
 * `export-alexa` was always there.
 *
 * Extension: an OIDC addon can register another `auth-provider` entry.
 * The server's login flow iterates the `auth-provider` collection.
 */
import * as fs from 'node:fs'
import { X509Certificate } from 'node:crypto'
import type {
  IDeviceCredentialsProvider,
  ISsoBridgeProvider,
  IUserManagementProvider,
  ProviderRegistration,
} from '@camstack/types'
import {
  authProviderCapability,
  BaseAddon,
  buildDeviceEnrollmentLink,
  deviceCredentialsCapability,
  formatDeviceRevoker,
  userManagementCapability,
} from '@camstack/types'
import { DeviceCaStore } from '../../auth/device-ca-store.js'
import { DeviceCredentialManager } from '../../auth/device-credential-manager.js'
import { AuthManager } from '../../auth/auth-manager.js'
import { assertPersonScopes } from './person-scopes.js'
import { JwtSigningKeyKeeper } from './jwt-signing-key-keeper.js'
import { ExternalIdentityManager } from '../../auth/external-identity-manager.js'
import { AuthAuditLog } from '../../auth/auth-audit-log.js'
import { LoginSessionManager } from '../../auth/login-session-manager.js'
import { TotpManager } from '../../auth/totp-manager.js'
import { UserManager, type UserRecord } from '../../auth/user-manager.js'
import {
  attachUserManagementInternal,
  type UserManagementInternal,
} from '../../auth/user-management-internal.js'
import { reconcileAdminAccountAtBoot } from './admin-account-boot.js'
import { createAuthConfigReader } from './auth-config-reader.js'
import { declareAuthSchema } from './auth-schema.js'
import {
  LOCAL_AUTH_RECORDS_LEGACY_COLLECTIONS,
  localAuthRecordKinds,
  localAuthRecordStoresOf,
} from './record-kinds.js'
import { createOauthGrants } from './oauth-grants.js'
import { localAuthPreferencesRecordKinds } from './preferences-record-kinds.js'
import { UserPreferencesStore } from './user-preferences-store.js'
import { OauthSessionManager } from './oauth-session-manager.js'
import { userError } from '@camstack/types'

/** How often the auth tables are swept for dead rows. */
const AUTH_REAP_INTERVAL_MS = 24 * 3600_000

/**
 * How long a REVOKED OAuth session is kept before deletion.
 *
 * A revoked link authorises nothing the moment it is revoked (every consumer
 * fails closed on a missing session exactly as on a revoked one), so this
 * window buys only the operator's ability to answer "when did I unlink that?".
 * 30 days, matching the ops-log retention.
 */
const OAUTH_REVOKED_RETENTION_MS = 30 * 24 * 3600_000

// ── Auth result (mirrors auth-provider cap) ─────────────────────────

interface AuthResult {
  readonly userId: string
  readonly username: string
  readonly email?: string
  readonly displayName?: string
  readonly isAdmin: boolean
}

function toAuthResult(user: UserRecord): AuthResult {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.username,
    isAdmin: user.isAdmin,
  }
}

export class LocalAuthAddon extends BaseAddon {
  private authManager: AuthManager | null = null
  private userManager: UserManager | null = null
  private oauthSessionManager: OauthSessionManager | null = null
  private reapTimer: ReturnType<typeof setInterval> | null = null
  private totpManager: TotpManager | null = null
  private externalIdentities: ExternalIdentityManager | null = null
  private signingKeyKeeper: JwtSigningKeyKeeper | null = null
  private loginSessions: LoginSessionManager | null = null
  private auditLog: AuthAuditLog | null = null
  private deviceCredentials: DeviceCredentialManager | null = null
  private deviceCa: DeviceCaStore | null = null
  private preferences: UserPreferencesStore | null = null

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    // The session signing key: from the keychain (owner `system`), into the
    // process slot every AuthManager reads — this one and the hub's
    // AuthService alike (D797). Locked keychain → sessions refused, loudly;
    // never a fallback key.
    const forOwner = this.ctx.secrets?.forOwner ?? null
    this.signingKeyKeeper = new JwtSigningKeyKeeper({
      secrets: forOwner === null ? null : forOwner('system'),
      logger: this.ctx.logger,
    })
    await this.signingKeyKeeper.start()

    // The session lifetime is the one `auth` value this addon reads: the
    // reader is synchronous, so it is pre-resolved here. Left absent (not
    // defaulted) when the operator has set nothing — DEFAULT_TOKEN_EXPIRY is
    // applied by the signer, once.
    const authSection = (await this.ctx.settings?.getSection('auth')) ?? {}
    const resolvedTokenExpiry =
      typeof authSection['tokenExpiry'] === 'string' && authSection['tokenExpiry']
        ? authSection['tokenExpiry']
        : undefined

    const reader = createAuthConfigReader({ tokenExpiry: resolvedTokenExpiry })

    this.authManager = new AuthManager(reader, this.ctx.logger)

    const store = this.ctx.api?.settingsStore
    const records = this.ctx.records
    if (store && records) {
      // The auth kinds are records kinds on every hub (D881); the records
      // migration that copied the legacy tables is closed (D900).
      await records.declare(localAuthRecordKinds)
      const authStores = localAuthRecordStoresOf(records)
      await records.declare(localAuthPreferencesRecordKinds)
      this.preferences = new UserPreferencesStore(
        records.kind(localAuthPreferencesRecordKinds['user-preferences']),
      )
      await declareAuthSchema(store, {
        skipCollections: LOCAL_AUTH_RECORDS_LEGACY_COLLECTIONS,
      })
      this.userManager = new UserManager(
        { usersKind: authStores.users, legacyStore: store },
        this.authManager,
      )
      this.oauthSessionManager = new OauthSessionManager({
        oauthSessionsKind: authStores.oauthSessions,
      })
      this.totpManager = new TotpManager(
        { userTotpKind: authStores.userTotp, legacyStore: store },
        {
          secrets: forOwner === null ? null : forOwner('system'),
          logger: this.ctx.logger,
        },
      )
      this.externalIdentities = new ExternalIdentityManager({
        identitiesKind: authStores.userExternalIdentities,
        legacyStore: store,
      })
      this.loginSessions = new LoginSessionManager(
        {
          sessionsKind: authStores.loginSessions,
          cutoffsKind: authStores.loginSessionCutoffs,
          legacyStore: store,
        },
        { logger: this.ctx.logger },
      )
      await this.loginSessions.load()
      this.auditLog = new AuthAuditLog(
        { authAuditKind: authStores.authAudit, legacyStore: store },
        this.ctx.logger,
      )
      const deviceUsers = this.userManager
      this.deviceCa = new DeviceCaStore({
        secrets: forOwner === null ? null : forOwner('system'),
        readSection: async (section) => (await this.ctx.settings?.getSection(section)) ?? {},
        writeSection: async (section, patch) => {
          await this.ctx.settings?.setSection(section, patch)
        },
        logger: this.ctx.logger,
      })
      this.deviceCredentials = new DeviceCredentialManager(store, {
        ca: this.deviceCa,
        findUser: async (userId) => {
          const user = await deviceUsers.findById(userId)
          return user === null ? null : { username: user.username }
        },
        selfEnrollmentAllowed: async () =>
          (await this.readDeviceCertificateSettings()).selfEnrollment === 'allowed',
        deviceCredentialsKind: authStores.deviceCredentials,
        logger: this.ctx.logger,
      })
      await this.deviceCredentials.load()
      try {
        // Caps-only auth data migration (super_admin→admin + scopes:[]
        // backfill) is owned by `scripts/migrate-auth-caps-only.ts`, run
        // ONCE out-of-band before deploying this build. The boot path
        // no longer carries the migration code — re-running it on every
        // restart conflated "schema migration" with "ongoing init" and
        // would let a forgotten cleanup ship to prod silently. Boot now
        // trusts the on-disk schema to be current; if `ensureAdminExists`
        // hits a parse error, you know the
        // migration script wasn't run.
        await reconcileAdminAccountAtBoot({
          users: this.userManager,
          dataDir: this.ctx.nodeDataDir,
          fs: {
            exists: (filePath) => fs.existsSync(filePath),
            remove: (filePath) => fs.rmSync(filePath, { force: true }),
          },
          logger: this.ctx.logger,
        })
        const liveUsers = await this.userManager.listAll()
        const liveIds = new Set(liveUsers.map((u) => u.id))
        // A delete whose preference wipe failed (logged there) converges here.
        // Housekeeping: a failed sweep is logged and never fails auth boot.
        try {
          const orphanPrefs = await this.preferences.wipeOrphans(liveIds)
          if (orphanPrefs > 0) {
            this.ctx.logger.warn(
              `cleaned up ${orphanPrefs} orphan account-preference row(s) on boot`,
            )
          }
        } catch (err: unknown) {
          this.ctx.logger.warn('account-preference orphan sweep failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
        // Retention for the two auth tables that had none: expired tokens and
        // long-revoked account links accumulated for the life of the install.
        // At boot AND on a daily tick — a hub that runs for weeks would
        // otherwise never reap, and a hub that never restarts is the normal
        // case, not the exception.
        await this.reapAuthRows()
        this.reapTimer = setInterval(() => {
          void this.reapAuthRows()
        }, AUTH_REAP_INTERVAL_MS)
        // Never hold the process open for a retention sweep.
        this.reapTimer.unref?.()
      } catch (err: unknown) {
        // Surface the underlying cause loudly: AddonRegistry catches
        // and skips on throw, leaving auth.login to return the opaque
        // "User management not available" message at runtime. The
        // wrap below makes the actual fault (settings-store query
        // shape regression, sqlite migration glitch, …) visible in
        // both the addon error log and the user-facing error chain.
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(
          'local-auth bootstrap failed: ensureAdminExists threw before ' +
            '`user-management` could be registered. Most likely a ' +
            '`users` collection schema mismatch in the settings-store. ' +
            `Underlying: ${detail}`,
          { cause: err },
        )
      }
    } else if (store && records === undefined) {
      throw new Error(
        'local-auth: ctx.records is required on the hub (records phase 6). ' +
          'Deploy a closure that includes the records primitive before local-auth.',
      )
    } else {
      throw new Error(
        'local-auth: settings-store API not available — refusing to ' +
          'register `user-management` cap. Check that `sqlite-storage` ' +
          'addon initialized before `local-auth`.',
      )
    }

    // ── auth-provider capability (collection) ──────────────────────

    const authProvider = {
      validateCredentials: async (input: {
        username: string
        password: string
      }): Promise<AuthResult | null> => {
        if (!this.userManager) return null
        const user = await this.userManager.validateCredentials(input.username, input.password)
        return user ? toAuthResult(user) : null
      },
      getLoginUrl: async (): Promise<string> => {
        throw new Error('local-auth: URL-based login not supported')
      },
      handleCallback: async (): Promise<AuthResult> => {
        throw new Error('local-auth: URL-based login not supported')
      },
      validateToken: async (input: { token: string }): Promise<AuthResult | null> => {
        if (!this.authManager || !this.userManager) return null
        try {
          const payload = this.authManager.verifyToken(input.token)
          const userId = payload.userId
          if (!userId) return null
          const user = await this.userManager.findById(userId)
          return user ? toAuthResult(user) : null
        } catch {
          return null
        }
      },
    }

    // ── user-management capability (singleton) ─────────────────────

    // Lazily memoized OAuth grants object. Resolved on first call so we
    // don't depend on `sso-bridge` being registered before local-auth
    // finishes its `onInitialize` phase.
    let cachedOauthGrants: ReturnType<typeof createOauthGrants> | null = null
    const lazyOauthGrants = (): ReturnType<typeof createOauthGrants> => {
      if (cachedOauthGrants) return cachedOauthGrants
      // ctx.api.ssoBridge is the tRPC client-side router for the sso-bridge
      // capability. We wrap it into an ISsoBridgeProvider-shaped object so
      // createOauthGrants can call it uniformly without knowing about tRPC.
      const bridgeApi = this.ctx.api?.ssoBridge
      if (!bridgeApi)
        throw new Error(
          'local-auth: sso-bridge capability not available via ctx.api — hub boot incomplete',
        )
      const ssoBridgeProvider: ISsoBridgeProvider = {
        signBridgeToken: (input) => bridgeApi.signBridgeToken.query(input),
        verifyBridgeToken: (input) => bridgeApi.verifyBridgeToken.query(input),
      }
      if (!this.oauthSessionManager)
        throw new Error('local-auth: oauthSessionManager not initialized — hub boot incomplete')
      cachedOauthGrants = createOauthGrants(ssoBridgeProvider, this.oauthSessionManager)
      return cachedOauthGrants
    }

    const userMgmt: IUserManagementProvider = {
      listUsers: async () => {
        if (!this.userManager) return []
        const users = await this.userManager.listAll()
        // Decorate with `totpEnabled` so the admin Users page can show
        // the "Remove 2FA" action conditionally without N round-trips.
        // Falls back to `false` when the totpManager isn't wired.
        if (!this.totpManager) return users.map((u) => ({ ...u, totpEnabled: false }))
        const statuses = await Promise.all(
          users.map((u) => this.totpManager!.getStatus(u.id).catch(() => ({ enabled: false }))),
        )
        return users.map((u, i) => ({
          ...u,
          totpEnabled: statuses[i]?.enabled ?? false,
        }))
      },
      createUser: async (input) => {
        if (!this.userManager) throw new Error('User management not available')
        const record = await this.userManager.create(input)
        const { passwordHash: _, ...summary } = record
        return { ...summary, totpEnabled: false }
      },
      updateUser: async (input) => {
        if (!this.userManager) throw new Error('User management not available')
        const { id, ...data } = input
        await this.userManager.update(id, data)
        return { success: true as const }
      },
      deleteUser: async (input) => {
        if (!this.userManager) throw new Error('User management not available')
        await this.userManager.delete(input.id)
        // Everything that let this user in ends in the same call — sessions,
        // scoped tokens, OAuth links, the 2FA row. They used to survive until
        // the next restart's orphan sweep. D782: the sign-in links go too — a
        // stale link would sign the identity in as nobody (or, after an id
        // reuse, as somebody else).
        await this.endAllAccess(input.id)
        return { success: true as const }
      },
      resetPassword: async (input) => {
        if (!this.userManager) throw new Error('User management not available')
        await this.userManager.resetPassword(input.id, input.newPassword)
        // An admin reset: every session of the user ends (the user signs in
        // again with the new password).
        await this.loginSessions?.revokeAllForUser(input.id, {
          reason: 'password-reset',
        })
        // An admin reset means the account may have been compromised: every
        // device credential of the user dies too (and the sessions they opened),
        // so a stolen phone cannot sign straight back in. The user re-enrolls.
        await this.revokeDeviceCredentialsForReset(input.id)
        return { success: true as const }
      },
      setUserScopes: async (input) => {
        if (!this.userManager) throw new Error('User management not available')
        // A person stores nothing (admin) or one viewer row. Token rows are
        // refused here; they are minted onto tokens, not onto users (D921).
        assertPersonScopes(input.scopes)
        // Authorization model — caps-only refactor v1:
        //   • `auth: 'admin'` on the cap method gates this to admin
        //     callers in `protectedProcedure` (admin bypass + role check
        //     in `adminProcedure`).
        //   • Admins are intentionally unscoped — their scope set is
        //     ignored everywhere. There's nothing for a subset check
        //     to clamp against; admin is the universe.
        //   • The UI clamps the picker via `clampToParent` to the
        //     caller's scopes; for admin callers that's null (no clamp).
        //
        // If we ever expose `setUserScopes` to a non-admin role (e.g.
        // delegating team-leads), wire a structural caller-scope subset
        // check here using a ctx-injection pattern (see cap-router
        // codegen TODO).
        await this.userManager.update(input.userId, { scopes: input.scopes })
        return { success: true as const }
      },
      validateCredentials: async (input) => {
        if (!this.userManager) return null
        const user = await this.userManager.validateCredentials(input.username, input.password)
        if (!user) return null
        // `UserSummary` now includes `totpEnabled` — populate from the
        // TOTP manager so the login flow can branch on 2FA without an
        // extra round-trip.
        const totpEnabled = this.totpManager
          ? (await this.totpManager.getStatus(user.id).catch(() => ({ enabled: false }))).enabled
          : false
        return { ...user, totpEnabled }
      },

      // ── OAuth account-linking grant ───────────────────────────────
      //
      // `sso-bridge` is registered by the hub main.ts AFTER the core
      // addon registry boots, so we cannot resolve it eagerly in
      // `onInitialize`. Instead we resolve it lazily on the first call
      // and memoize — `ctx.api.ssoBridge` routes through the cap link
      // chain and resolves locally when co-located, transparently.
      oauthIssueCode: async (input) => {
        return lazyOauthGrants().oauthIssueCode(input)
      },
      oauthExchangeCode: async (input) => {
        return lazyOauthGrants().oauthExchangeCode(input)
      },
      oauthRefresh: async (input) => {
        return lazyOauthGrants().oauthRefresh(input)
      },
      oauthVerifyAccessToken: async (input) => {
        return lazyOauthGrants().oauthVerifyAccessToken(input)
      },
      listOauthSessions: async () => {
        if (!this.oauthSessionManager) return []
        const sessions = await this.oauthSessionManager.list()
        return sessions.map((s) => ({
          id: s.id,
          userId: s.userId,
          username: s.username,
          integrationId: s.integrationId,
          scopes: s.scopes,
          createdAt: s.createdAt,
          lastUsedAt: s.lastUsedAt,
          revokedAt: s.revokedAt,
        }))
      },
      // ── External sign-in identities (D782) ────────────────────────
      listExternalIdentities: async (input) => {
        if (!this.externalIdentities) return []
        return [...(await this.externalIdentities.listForUser(input.userId))]
      },
      findUserByExternalIdentity: async (input) => {
        if (!this.externalIdentities) return null
        const link = await this.externalIdentities.findLink(input.provider, input.subject)
        return link === null ? null : { userId: link.userId, issuer: link.issuer }
      },
      unlinkExternalIdentity: async (input) => {
        if (!this.externalIdentities) return { success: false }
        return { success: await this.externalIdentities.unlink(input) }
      },
      revokeOauthSession: async (input) => {
        if (!this.oauthSessionManager) return { success: false }
        const ok = await this.oauthSessionManager.markRevoked(input.id)
        return { success: ok }
      },

      // ── TOTP / 2FA ────────────────────────────────────────────────
      setupTotp: async (input) => {
        if (!this.totpManager || !this.userManager) throw new Error('TOTP management not available')
        const user = await this.userManager.findById(input.userId)
        if (!user) throw new Error(`User not found: ${input.userId}`)
        return this.totpManager.setup(user.id, user.username)
      },
      confirmTotp: async (input) => {
        if (!this.totpManager) throw new Error('TOTP management not available')
        const ok = await this.totpManager.confirm(input.userId, input.code)
        if (!ok)
          throw userError(
            'auth.totp-confirm-failed',
            undefined,
            'TOTP confirmation failed — code did not match',
          )
        return { success: true as const }
      },
      disableTotp: async (input) => {
        if (!this.totpManager) throw new Error('TOTP management not available')
        await this.totpManager.disable(input.userId)
        return { success: true as const }
      },
      getTotpStatus: async (input) => {
        if (!this.totpManager) return { enabled: false, confirmedAt: null }
        return this.totpManager.getStatus(input.userId)
      },
      migrateRawSecrets: async (input) => {
        if (!this.totpManager) throw new Error('TOTP management not available')
        return this.totpManager.migrateRawSecrets(input.apply)
      },
      verifyTotp: async (input) => {
        if (!this.totpManager) return { valid: false }
        const valid = await this.totpManager.verify(input.userId, input.code)
        return { valid }
      },
    }

    this.ctx.logger.info('registered auth-provider + user-management capabilities')
    attachUserManagementInternal(userMgmt, this.buildInternal())
    return [
      { capability: authProviderCapability, provider: authProvider },
      { capability: userManagementCapability, provider: userMgmt },
      {
        capability: deviceCredentialsCapability,
        provider: this.buildDeviceCredentialsProvider(),
      },
    ]
  }

  private async readDeviceCertificateSettings(): Promise<{
    readonly selfEnrollment: 'allowed' | 'disabled'
  }> {
    const section = (await this.ctx.settings?.getSection('deviceCertificates')) ?? {}
    return {
      selfEnrollment: section['selfEnrollment'] === 'disabled' ? 'disabled' : 'allowed',
    }
  }

  private async revokeDeviceCredentialsForReset(
    userId: string,
    by: 'password-reset' | 'password-changed' = 'password-reset',
  ): Promise<void> {
    const ids = (await this.deviceCredentials?.revokeAllForUser(userId, by)) ?? []
    for (const id of ids) {
      const ended = (await this.loginSessions?.revokeByCredential(id)) ?? 0
      await this.auditLog?.record({
        action: 'device-credential-revoked',
        userId,
        detail: { credentialId: id, by, sessionsEnded: ended },
      })
    }
  }

  /** The admin cap (`device-credentials`): list, enroll-by-QR, revoke, rename, settings. */
  private buildDeviceCredentialsProvider(): IDeviceCredentialsProvider {
    const manager = (): DeviceCredentialManager => {
      if (this.deviceCredentials === null)
        throw userError(
          'device.credentials-unavailable',
          undefined,
          'Device credentials not available',
        )
      return this.deviceCredentials
    }
    const hubOrigins = async (): Promise<readonly string[]> => {
      try {
        const book = await this.ctx.api?.localNetwork?.getAddresses?.query({})
        if (!book) return []
        // Public endpoint first (a phone leaves the LAN), then every appConnections address.
        const ordered = [book.roles.publicEndpoint.resolved, ...book.roles.appConnections.resolved]
        return [...new Set(ordered.filter((o): o is string => typeof o === 'string'))].filter(
          (o) => !/^https?:\/\/(127\.|localhost|\[::1\])/i.test(o),
        )
      } catch (err: unknown) {
        this.ctx.logger.warn('Enrollment link: the hub address could not be resolved', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        return []
      }
    }
    return {
      listDeviceCredentials: async (input) => {
        const users = new Map(
          ((await this.userManager?.listAll()) ?? []).map((u) => [u.id, u.username] as const),
        )
        return manager()
          .list({
            ...(input.userId !== undefined ? { userId: input.userId } : {}),
            includeRevoked: input.includeRevoked,
          })
          .map((r) => manager().toSummary(r, users.get(r.userId) ?? null))
      },
      startEnrollment: async (input) => {
        if ((await this.userManager?.findById(input.userId)) == null) {
          throw new Error(`User not found: ${input.userId}`)
        }
        const started = manager().startEnrollment({
          userId: input.userId,
          deviceName: input.deviceName,
          createdBy: input.caller.userId,
        })
        const origins = await hubOrigins()
        const hub = origins[0]
        await this.auditLog?.record({
          action: 'device-credential-enrolled',
          userId: input.userId,
          detail: { stage: 'code-issued', by: input.caller.userId },
        })
        return {
          code: started.code,
          expiresAt: started.expiresAt,
          enrollUrl: buildDeviceEnrollmentLink({
            ...(hub !== undefined ? { hub } : {}),
            code: started.code,
          }),
          hubOrigin: hub ?? null,
          hubOrigins: [...origins],
        }
      },
      revokeDeviceCredential: async (input) => {
        const record = manager().get(input.id)
        if (record === undefined)
          throw userError(
            'device.credential-not-found',
            { id: input.id },
            `Device credential not found: ${input.id}`,
          )
        const revoked = await manager().revoke(
          input.id,
          formatDeviceRevoker({ kind: 'admin', userId: input.caller.userId }),
        )
        // The sessions go whether or not this call revoked it (idempotent retry).
        const sessionsEnded = (await this.loginSessions?.revokeByCredential(input.id)) ?? 0
        if (revoked) {
          await this.auditLog?.record({
            action: 'device-credential-revoked',
            userId: record.userId,
            detail: {
              credentialId: input.id,
              by: input.caller.userId,
              sessionsEnded,
            },
          })
        }
        return {
          revoked,
          sessionsEnded,
          status: 'revoked' as const,
        }
      },
      deleteDeviceCredential: async (input) => {
        const record = manager().get(input.id)
        const result = await manager().delete(input.id)
        if (result === 'deleted' && record !== undefined) {
          await this.auditLog?.record({
            action: 'device-credential-revoked',
            userId: record.userId,
            detail: {
              credentialId: input.id,
              stage: 'row-deleted',
              by: input.caller.userId,
            },
          })
        }
        return { result }
      },
      renameDeviceCredential: async (input) => ({
        renamed: await manager().rename(input.id, input.deviceName),
      }),
      getDeviceCaStatus: async () => {
        if (this.deviceCa === null)
          return { state: 'unavailable' as const, reason: 'not initialised' }
        const found = await this.deviceCa.lookup()
        if (found.state !== 'ready') {
          return found.state === 'absent'
            ? { state: 'absent' as const }
            : { state: 'unavailable' as const, reason: found.reason }
        }
        const x509 = new X509Certificate(found.ca.certPem)
        return {
          state: 'ready' as const,
          subject: x509.subject,
          fingerprintSha256: x509.fingerprint256,
          validTo: x509.validTo,
        }
      },
      getDeviceCertificateSettings: async () => this.readDeviceCertificateSettings(),
      setDeviceCertificateSettings: async (input) => {
        await this.ctx.settings?.setSection('deviceCertificates', {
          selfEnrollment: input.selfEnrollment,
        })
        return this.readDeviceCertificateSettings()
      },
    }
  }

  /**
   * The hub-internal surface (`user-management-internal.ts`): operations no
   * wire may reach. Called only by hub code holding this provider object.
   */
  private buildInternal(): UserManagementInternal {
    const sessions = (): LoginSessionManager => {
      if (this.loginSessions === null) throw new Error('Login sessions not available')
      return this.loginSessions
    }
    const devices = (): DeviceCredentialManager => {
      if (this.deviceCredentials === null)
        throw userError(
          'device.credentials-unavailable',
          undefined,
          'Device credentials not available',
        )
      return this.deviceCredentials
    }
    const preferences = this.preferences
    return {
      ...(preferences !== null ? { preferences } : {}),
      sessions: {
        create: (input) => sessions().create(input),
        refresh: (token, lifetimeMs) => sessions().refresh(token, lifetimeMs),
        extend: (id, lifetimeMs) => sessions().extend(id, lifetimeMs),
        check: (id) => sessions().check(id),
        legacyCutoff: (userId) => sessions().legacyCutoff(userId),
        revoke: (id, reason) => sessions().revoke(id, reason),
        revokeAllForUser: (userId, options) => sessions().revokeAllForUser(userId, options),
        listForUser: (userId) => sessions().listForUser(userId),
        listActive: () => sessions().listActive(),
        revokeByCredential: (credentialId, reason) =>
          sessions().revokeByCredential(credentialId, reason),
        peekByRefreshToken: (token) => sessions().peekByRefreshToken(token),
      },
      deviceCredentials: {
        completeEnrollment: (input) => devices().completeEnrollment(input),
        enrollSelf: (input) => devices().enrollSelf(input),
        issueNonce: (origin) => devices().issueNonce(origin),
        authenticate: (input) => devices().authenticate(input),
        renew: (credential) => devices().renew(credential),
        check: (id) => devices().check(id),
        get: (id) => devices().get(id),
        revoke: (id, by) => devices().revoke(id, by),
        list: (input) => devices().list(input),
      },
      oauthSessions: {
        revoke: async (id) => {
          if (this.oauthSessionManager === null) return false
          const session = await this.oauthSessionManager.getById(id)
          if (session === null) return false
          // Already revoked → drop the row so Identity can clear the list.
          if (session.revokedAt !== null) return this.oauthSessionManager.remove(id)
          return this.oauthSessionManager.markRevoked(id)
        },
      },
      audit: {
        record: async (event) => {
          await this.auditLog?.record(event)
        },
        list: async (input) => (this.auditLog === null ? [] : this.auditLog.list(input)),
      },
      setPassword: async (input) => {
        if (!this.userManager) throw new Error('User management not available')
        await this.userManager.resetPassword(input.userId, input.newPassword)
        await sessions().revokeAllForUser(input.userId, {
          ...(input.keepSessionId !== undefined ? { exceptSessionId: input.keepSessionId } : {}),
          reason: 'password-changed',
        })
        // The user's OWN password change ends their other sessions (above) and, like an admin
        // reset, every device credential - and the sessions they opened, even the current one
        // when it is a certificate session: a changed password is a reason to re-enroll devices.
        await this.revokeDeviceCredentialsForReset(input.userId, 'password-changed')
      },
      linkExternalIdentity: async (input) => {
        if (!this.externalIdentities || !this.userManager) {
          throw new Error('External sign-in linking not available')
        }
        const user = await this.userManager.findById(input.userId)
        if (!user) throw new Error(`User not found: ${input.userId}`)
        await this.externalIdentities.link(input)
        return { success: true as const }
      },
    }
  }

  /**
   * End every way `userId` could still get in: login sessions (and the
   * pre-session tokens, via the cutoff), scoped tokens, OAuth account links,
   * the TOTP row and the external sign-in links. Each step is attempted even
   * if an earlier one fails, and a failure is logged — a half-cleaned user is
   * worse than a loud one.
   */
  private async endAllAccess(userId: string): Promise<void> {
    const steps: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      [
        'sessions',
        async () =>
          this.loginSessions?.revokeAllForUser(userId, {
            reason: 'user-deleted',
          }),
      ],
      [
        'oauth sessions',
        async () => {
          for (const session of (await this.oauthSessionManager?.list()) ?? []) {
            if (session.userId === userId && session.revokedAt === null) {
              await this.oauthSessionManager?.markRevoked(session.id)
            }
          }
        },
      ],
      [
        'device credentials',
        async () => {
          for (const id of (await this.deviceCredentials?.revokeAllForUser(
            userId,
            'user-deleted',
          )) ?? []) {
            await this.loginSessions?.revokeByCredential(id)
          }
        },
      ],
      ['totp', async () => this.totpManager?.disable(userId)],
      ['sign-in links', async () => this.externalIdentities?.removeAllForUser(userId)],
      // D894: a deleted user's account preferences are private to them and go too.
      ['account preferences', async () => this.preferences?.wipeUser(userId)],
    ]
    for (const [what, step] of steps) {
      try {
        await step()
      } catch (err: unknown) {
        this.ctx.logger.error(`deleting a user: could not remove its ${what}`, {
          meta: {
            userId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
  }

  /**
   * Drop auth rows that are dead but were never removed: OAuth sessions
   * revoked longer ago than {@link OAUTH_REVOKED_RETENTION_MS}, dead login
   * sessions, old audit rows, dead device credentials. (Tokens are the hub's
   * `credential-tokens` rows, reaped there.)
   *
   * No such row could authorise anything — every consumer treats a missing
   * session exactly like a revoked one. So this is hygiene, and it is best-effort: a failed sweep is logged
   * and the next tick tries again. It must never be able to fail boot.
   */
  private async reapAuthRows(): Promise<void> {
    try {
      const sessions =
        (await this.oauthSessionManager?.reapRevoked(Date.now() - OAUTH_REVOKED_RETENTION_MS)) ?? 0
      const logins = (await this.loginSessions?.reap()) ?? 0
      await this.auditLog?.reap()
      await this.deviceCredentials?.reap()
      if (sessions > 0 || logins > 0) {
        this.ctx.logger.info('auth retention swept', {
          meta: { revokedSessions: sessions, deadLoginSessions: logins },
        })
      }
    } catch (err: unknown) {
      // A silent retention failure is how a table grows forever without
      // anyone noticing — the whole reason these two did not exist.
      this.ctx.logger.warn('auth retention sweep failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  protected async onShutdown(): Promise<void> {
    // The process slot keeps the last key: an addon restart must not log
    // everyone out for the seconds it takes to come back.
    this.signingKeyKeeper?.stop()
    this.signingKeyKeeper = null
    if (this.reapTimer !== null) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
    this.authManager = null
    this.userManager = null
    this.oauthSessionManager = null
    this.externalIdentities = null
    this.loginSessions = null
    this.auditLog = null
    this.deviceCredentials = null
    this.deviceCa = null
  }
}

export default LocalAuthAddon
