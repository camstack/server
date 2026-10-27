import { splitApplianceSecrets } from './config.js'
import type { HomeConnectAccountLogin } from './home-connect-login.js'
import { parseLoginDeviceDescription } from './home-connect-stored-appliance.js'

/** What a finished Home Connect sign-in hands the form (the `finishSignIn` action result). */
export interface HomeConnectFinishResult {
  readonly token: string
  readonly refresh?: string
  readonly accountLabel: string
  readonly appliances: string
  readonly applianceSecrets: string
  readonly summary: string
}

export function homeConnectFinishResult(account: HomeConnectAccountLogin): HomeConnectFinishResult {
  // The pairing keys go to the keychain through `applianceSecrets`; the rows carry none.
  const { rows, secrets } = splitApplianceSecrets(
    account.appliances.map((app) => ({
      haId: app.haId,
      name: app.name,
      type: app.type,
      host: app.connection.host,
      psk: app.connection.psk,
      mode: app.connection.mode,
      ...(app.connection.iv64.length > 0 ? { iv64: app.connection.iv64 } : {}),
      ...parseLoginDeviceDescription(app.connection.deviceDescription),
    })),
  )
  return {
    token: account.token,
    ...(account.refresh.length > 0 ? { refresh: account.refresh } : {}),
    accountLabel: account.accountId,
    appliances: JSON.stringify(rows),
    applianceSecrets: JSON.stringify(secrets),
    summary: account.summary,
  }
}
