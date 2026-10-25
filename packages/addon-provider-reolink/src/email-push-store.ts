/**
 * The store snapshot the email-push SMTP intake reads.
 *
 * `emailPushAuthPassword` is hidden state kept in the keychain (D787): the raw
 * addon store (`resolveGlobalStore()`) holds a `{ $secret }` MARKER in its
 * place. The value comes from the addon's durable-state handle, which resolves
 * the marker. When the keychain cannot resolve it the marker is LEFT in the
 * snapshot — the server reads that as "stored but unavailable", never as
 * "absent", so it never bootstraps a replacement over the kept password.
 */
export interface EmailPushStoreDeps {
  /** The raw addon store (markers unresolved). */
  readonly readRaw: () => Promise<Record<string, unknown>>
  /** The resolved SMTP AUTH password; `''` when absent or unresolvable. */
  readonly readPassword: () => Promise<string>
}

export async function readEmailPushStore(
  deps: EmailPushStoreDeps,
): Promise<Record<string, unknown>> {
  const raw = await deps.readRaw()
  const password = await deps.readPassword()
  return password.length > 0 ? { ...raw, emailPushAuthPassword: password } : raw
}
