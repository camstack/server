/**
 * Platform passkeys inside the viewer window (Electron 42).
 *
 * Until `app.configureWebAuthn` runs, `isUserVerifyingPlatformAuthenticatorAvailable()`
 * resolves false and platform requests are not serviced; and a request that
 * resolves several discoverable credentials stays pending until the
 * `select-webauthn-account` listener answers EXACTLY ONCE. Both are here.
 *
 * The pieces with a decision in them are pure and injectable; `main.ts` binds
 * them to `app` and `dialog`.
 */

export interface WebAuthnAccountLike {
  readonly credentialId: string
  readonly displayName?: string
  readonly name?: string
}

export interface TouchIdConfig {
  readonly keychainAccessGroup: string
  readonly promptReason: string
}

/** The suffix of the keychain access group: `<TEAM_ID>.<bundle id>.webauthn`. */
export const WEBAUTHN_GROUP_SUFFIX = 'com.camstack.app.webauthn'

/** The Info.plist key electron-builder stamps the signing team id under (`extendInfo`). */
export const TEAM_ID_INFO_KEY = 'CamstackTeamId'

/** A team id is ten upper-case alphanumerics; anything else (empty, an unexpanded macro) is none. */
export function parseTeamIdFromInfoPlist(xml: string): string | null {
  const match = new RegExp(`<key>${TEAM_ID_INFO_KEY}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  const value = match?.[1]?.trim() ?? ''
  return /^[A-Z0-9]{10}$/.test(value) ? value : null
}

/** The provisioning profile a signed build embeds; the keychain group entitlement is valid only with it. */
export const PROVISIONING_PROFILE_FILE = 'embedded.provisionprofile'

/**
 * The `touchID` options, or `null` when the build carries no team id (an unsigned build)
 * or no embedded provisioning profile: without the profile the keychain group cannot be
 * granted, so platform passkeys stay off rather than fail at the prompt.
 */
export function touchIdConfigFor(
  teamId: string | null,
  hasProvisioningProfile: boolean,
): TouchIdConfig | null {
  if (teamId === null || !hasProvisioningProfile) return null
  return {
    keychainAccessGroup: `${teamId}.${WEBAUTHN_GROUP_SUFFIX}`,
    promptReason: 'sign in to CamStack with your passkey on $1',
  }
}

/** Label for one account in the chooser. */
export function accountLabel(account: WebAuthnAccountLike): string {
  const label = account.displayName ?? account.name ?? ''
  return label.length > 0 ? label : account.credentialId.slice(0, 8)
}

/** Picks one account; resolves its index, or `null` when the operator cancels. */
export type AccountChooser = (
  accounts: readonly WebAuthnAccountLike[],
  relyingPartyId: string,
) => Promise<number | null>

export type AccountCallback = (credentialId?: string | null) => void

/**
 * Answer a `select-webauthn-account` request. ALWAYS calls `callback` exactly
 * once — a chooser that throws, or an out-of-range pick, is a cancel — because
 * the credential request stays pending until it does.
 */
export async function answerAccountSelection(
  accounts: readonly WebAuthnAccountLike[],
  relyingPartyId: string,
  callback: AccountCallback,
  choose: AccountChooser,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  let selected: string | null = null
  try {
    if (accounts.length === 1) {
      selected = accounts[0]?.credentialId ?? null
    } else if (accounts.length > 1) {
      const index = await choose(accounts, relyingPartyId)
      selected = index === null ? null : (accounts[index]?.credentialId ?? null)
    }
  } catch (error) {
    log(`[webauthn] account chooser failed, cancelling: ${String(error)}`)
    selected = null
  } finally {
    callback(selected)
  }
}

/** The part of `dialog` the chooser needs. */
export interface MessageBoxLike {
  showMessageBox(options: {
    readonly type: 'question'
    readonly message: string
    readonly detail: string
    readonly buttons: string[]
    readonly cancelId: number
    readonly defaultId: number
  }): Promise<{ readonly response: number }>
}

/** A native chooser: one button per account, plus Cancel. */
export function createDialogChooser(dialog: MessageBoxLike): AccountChooser {
  return async (accounts, relyingPartyId) => {
    const cancelId = accounts.length
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: 'Choose a passkey',
      detail: `Several passkeys are saved for ${relyingPartyId}.`,
      buttons: [...accounts.map(accountLabel), 'Cancel'],
      cancelId,
      defaultId: 0,
    })
    return response === cancelId ? null : response
  }
}
