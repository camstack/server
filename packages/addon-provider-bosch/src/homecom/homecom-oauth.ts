/**
 * Public OAuth client of the HomeCom Easy / PointT mobile app, signed in through SingleKey ID.
 *
 * These are the PUBLIC values the app itself ships (a PKCE client has no secret). They are not
 * derivable from this repository; they come from the community PointT client (`homecom_alt`) and
 * have to be confirmed against a live account — see docs/addons/addon-provider-bosch-homecom.md.
 */
export const HOMECOM_CLIENT_ID = '762162C0-FA2D-4540-AE66-6489F189FADC'
export const HOMECOM_REDIRECT_URI = 'com.bosch.tt.dashtt.pointt://app/login'
export const HOMECOM_AUTHORIZE_URL = 'https://singlekey-id.com/auth/connect/authorize'
export const HOMECOM_TOKEN_URL = 'https://singlekey-id.com/auth/connect/token'
export const HOMECOM_SCOPE = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'pointt.gateway.claiming',
  'pointt.gateway.removal',
  'pointt.gateway.list',
  'pointt.gateway.users',
  'pointt.gateway.resource.dopair',
  'pointt.castt.flow.token-exchange',
  'bacon',
  'hcc.tariff.read',
].join(' ')
