/**
 * Ambient declaration for the one `alexa-cookie2` entry point the device-code sign-in
 * calls (the package ships no types). Only the refresh path is declared: the callback
 * receives the registration object (`localCookie`, `csrf`, `refreshToken`, …) which
 * the caller validates with Zod before using. A script file with no import/export, so
 * the `declare module` is ambient and emits nothing.
 */
declare module 'alexa-cookie2' {
  interface AlexaCookieRefreshOptions {
    readonly amazonPage: string
    readonly baseAmazonPage: string
    readonly acceptLanguage: string
    readonly formerRegistrationData: {
      readonly loginCookie: string
      readonly refreshToken: string
      readonly deviceSerial: string
      readonly amazonPage: string
      readonly macDms?: object
    }
  }
  interface AlexaCookieModule {
    refreshAlexaCookie(
      options: AlexaCookieRefreshOptions,
      callback: (err: Error | null, result: unknown) => void,
    ): void
  }
  const alexaCookie: AlexaCookieModule
  export default alexaCookie
}
