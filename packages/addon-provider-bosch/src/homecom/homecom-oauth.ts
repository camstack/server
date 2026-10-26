/**
 * Public OAuth client of the HomeCom Easy app, signed in through SingleKey ID.
 *
 * A PKCE client has no secret. The values are the ones SingleKey accepts for this client id
 * today: the same authorize query the MIT-licensed `homecom_alt` client records
 * (`OAUTH_LOGIN_PARAMS` — parameters, not copied code) and that the Home Assistant integration
 * opens. `pointt.gateway.resource.dopair` is not a scope this client may request; SingleKey
 * answers `misconfigured-application` and never shows the login page. The scope it does accept
 * names `pointt.gateway.resource.dashapp`, and the Bosch app sends `style_id=tt_bsch`.
 */
export const HOMECOM_CLIENT_ID = '762162C0-FA2D-4540-AE66-6489F189FADC'
export const HOMECOM_REDIRECT_URI = 'com.bosch.tt.dashtt.pointt://app/login'
export const HOMECOM_AUTHORIZE_URL = 'https://singlekey-id.com/auth/connect/authorize'
export const HOMECOM_TOKEN_URL = 'https://singlekey-id.com/auth/connect/token'
export const HOMECOM_STYLE_ID = 'tt_bsch'
export const HOMECOM_SCOPE = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'pointt.gateway.claiming',
  'pointt.gateway.removal',
  'pointt.gateway.list',
  'pointt.gateway.users',
  'pointt.gateway.resource.dashapp',
  'pointt.castt.flow.token-exchange',
  'bacon',
  'hcc.tariff.read',
].join(' ')
