/**
 * Values the Alexa app sends to Amazon. Taken from alexa-cookie2 (MIT, Copyright (c) Apollon77
 * and contributors); see assets/alexa-cookie2.LICENSE.md.
 */

export const APP_VERSION = '2.2.651540.0'
export const OS_VERSION = '18.3.1'
export const USER_AGENT = `AmazonWebView/Amazon Alexa/${APP_VERSION}/iOS/${OS_VERSION}/iPhone`
/** The Alexa app device type a registration presents as. */
export const DEVICE_TYPE = 'A2IVLV5VM2W81'
/** The registration name a CamStack sign-in records on the Amazon account. */
export const DEFAULT_DEVICE_APP_NAME = 'CamStack'
/** The name a registration made before the name was recorded refreshes under. */
export const LEGACY_DEVICE_APP_NAME = 'ioBroker Alexa2'

/** A token older than this is refreshed before a session is opened with it (24 h). */
export const REGISTRATION_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** The cookie and csrf of a registration are renewed this often (4 days). */
export const REGISTRATION_REFRESH_INTERVAL_MS = 4 * 24 * 60 * 60 * 1000
