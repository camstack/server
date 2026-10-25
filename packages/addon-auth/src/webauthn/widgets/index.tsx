/**
 * Widget bundle entry — built into `dist/webauthn/remoteEntry.js` by
 * `vite.widgets.config.ts`. Default export is the `Record<componentKey,
 * Component>` map the host's `WidgetRegistry` (and the pre-auth login
 * page's `loadRemoteBundle`) consume.
 */
import { PasskeyEnrollment } from './PasskeyEnrollment'
import { PasskeyLogin } from './PasskeyLogin'
import { PasskeyDirectLogin } from './PasskeyDirectLogin'

export default {
  'passkey-enrollment': PasskeyEnrollment,
  'passkey-login': PasskeyLogin,
  'passkey-direct-login': PasskeyDirectLogin,
}
