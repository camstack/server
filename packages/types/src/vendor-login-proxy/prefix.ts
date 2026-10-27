/**
 * The data-plane prefix every `VendorLoginProxy` is served under
 * (`/addon/<addonId>/vendor-login/<attemptId>/<vendorHost>/…`).
 *
 * The hub consults an addon's data-plane prefixes BEFORE its HTTP routes, so a
 * prefix equal to the first segment of a route the addon serves swallows that
 * route. A sign-in addon serves `/login/start|status|commit|cancel`; the proxy
 * therefore lives on a segment no addon route uses. One constant, so the entry
 * path, the mount and the docs cannot drift apart.
 */
export const VENDOR_LOGIN_PROXY_PREFIX = 'vendor-login'
