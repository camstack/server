import type { ConfigInfoField } from '@camstack/types'

/**
 * SingleKey ID signs in on its own page, which only works under SingleKey's own domains (its
 * captcha is bound to them), so the hub cannot show it. The operator signs in in their own
 * browser, and the last redirect — an address in the Bosch APP scheme that no browser can open —
 * is copied back by hand. This builds the explanation shown above the sign-in button.
 */

export interface SignInGuideInput {
  /** Form key prefix and i18n key prefix, e.g. `homecom.s_account`. */
  readonly i18nPrefix: string
  /** Prefix of the field keys, e.g. `__homecom`. */
  readonly keyPrefix: string
  readonly providerName: string
  /** The beginning of the address the browser cannot open, e.g. `com.bosch.tt.dashtt.pointt://app/login?code=`. */
  readonly redirectStart: string
}

export interface SignInGuideStep {
  readonly id: string
  readonly text: (input: SignInGuideInput) => string
}

export const SIGN_IN_GUIDE_STEPS: readonly SignInGuideStep[] = [
  {
    id: 'open',
    text: (g) =>
      `1. Click “Sign in with ${g.providerName}”. The sign-in page opens in a new tab of your own browser (it cannot be shown inside CamStack).`,
  },
  {
    id: 'login',
    text: () =>
      '2. Sign in there with your SingleKey ID: email, password and the one-time code if you are asked for one.',
  },
  {
    id: 'redirect',
    text: (g) =>
      `3. When you finish, the browser tries to open the Bosch app and fails or shows an empty page. That is expected: the address it tried to open is what CamStack needs. It starts with ${g.redirectStart}`,
  },
  {
    id: 'chrome',
    text: (g) =>
      `Chrome, Edge, Brave: before you sign in press F12, open Network and tick “Preserve log”. After the failure pick the last request whose address starts with ${g.redirectStart} and use right click, Copy, Copy URL (or copy the address from the error line in the Console).`,
  },
  {
    id: 'firefox',
    text: () =>
      'Firefox: before you sign in press F12, open Network, open the gear menu and enable “Persist Logs”. After the failure right click the last request, Copy Value, Copy URL.',
  },
  {
    id: 'safari',
    text: () =>
      'Safari: enable the Develop menu (Settings, Advanced), then Develop, Show Web Inspector, Network, and keep “Preserve Log” on. After the failure copy the address of the last request. Safari may also show the address in its “cannot open” message.',
  },
  {
    id: 'phone',
    text: () =>
      'Phone or tablet: the failed address often stays in the address bar; press and hold it to copy. If it does not, repeat the sign-in from a computer.',
  },
  {
    id: 'paste',
    text: () =>
      '4. Paste the whole address (or only the code after “code=”) in the box that appears under the button. The sign-in completes by itself; the code is valid for about ten minutes.',
  },
]

/** The info rows shown above the sign-in button: what to do and where each value comes from. */
export function buildSignInGuideFields(input: SignInGuideInput): ConfigInfoField[] {
  return SIGN_IN_GUIDE_STEPS.map((step) => ({
    type: 'info' as const,
    key: `${input.keyPrefix}-guide-${step.id}`,
    label: step.text(input),
    labelKey: `provider-bosch:${input.i18nPrefix}.${input.keyPrefix}-guide-${step.id}.label`,
    content: '',
  }))
}
