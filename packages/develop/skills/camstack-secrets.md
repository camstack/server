---
name: camstack-secrets
description: Handle a credential in CamStack — a password, token, API key or private key in an addon's settings, a device config, `secretStatePaths`, a token the addon mints, the hub's own secrets, or a credential a spawned child process (ffmpeg, a tunnel CLI) needs. Covers the keychain and `secret://` markers, declaring a secret by schema type, the read and clear rules, never using environment variables or argv, 0600 temp files for children, log scrubbing, the UI field, and the guards that enforce it. Use for "add a password field", "store a token", "pass a key to a subprocess", "a setting reads as { $secret }", "check-secret-fields-declared failed".
---

# Secrets and the keychain

Every password, token and key CamStack holds lives in ONE place: the hub's
keychain, encrypted. A settings blob, device config, integration or storage
location holds a **marker** where the value used to be:

```json
{ "$secret": "secret://<owner>/<scope>/<fieldPath>", "v": 1 }
```

Long form, with what it protects against and what it does not:
`docs/architecture/secrets-keychain.md`. Records: D783 (declared by type; never
on argv, env or logs), D787 (marker contract), D788 (master key location is
configuration), D789 (the admin form round-trips the marker), D797 (the hub's
own secrets), D798 (an addon reads its own settings resolved).

> Skill names with no file in this pack (`camstack-ui`, `camstack-ui-admin`,
> `camstack-server-change`, `camstack-diagnose`, `camstack-publish-ci`) are
> server-repository skills under `.claude/skills/`; this text stands on its own.

## 1. Workflow

1. **Declare** every secret by its schema TYPE (§2). Never rely on a key name.
2. **Read** it the resolved way and handle "stored but unavailable" (§3).
3. **Hand it to a child** only through an owner-only file (§4) — never env,
   never argv.
4. **Keep it out of logs, fixtures and the repository** (§5).
5. **Render** it with the library secret field (§6).
6. **Run the guards** (§7) and paste the done-gate (§8).

## 2. Declare it — by type, never by name

- Config-UI field: `type: 'password'`, or `secret: true` on a `text` /
  `textarea` field. Zod device-config field: `.meta({ secret: true })`.
  `storage: 'inline'` opts a field OUT (a masked non-secret). A JSON textarea
  that holds a secret stays inline — the keychain stores strings.
- A declared field is keychain-backed by `BaseAddon` with no further code: the
  blob stores the marker, `this.config` holds the value.
- **Hidden state that is a credential** — a token you mint or receive, never a
  form field — goes in `protected readonly secretStatePaths = [...]`
  (`'ingressToken'`, `'identity.pincode'`, `'tokens[userId].accessToken'`).
- **An array of rows with a secret** needs an id field (`itemIdKey`, default
  `'id'`): refs are addressed by item id, so a reorder keeps them.
- A credential-named field that is NOT declared fails
  `scripts/check-secret-fields-declared.ts`.

## 3. Read and clear it

- **Every read of your own settings answers VALUES** — `this.config`,
  `this.state()`, `this.resolveGlobalStore()`, `this.readStoredGlobalKey()`,
  every `this.ctx.settings.read*` — never a marker (D798). Writing back what you
  read is a no-op (no keychain version, no `onConfigChanged`).
- **Never touch the `initialize(context)` parameter's settings** — that is the
  kernel's unwrapped view and answers markers. Call `super.initialize(context)`
  and use `this.ctx`. `scripts/check-no-raw-secret-read.ts` fails on it.
- **Locked is never empty.** A value the keychain cannot serve right now reads
  as its MARKER (`isSecretMarker(v)` is true; it is listed in
  `this.unresolvedSecrets`) — never as `''` or absent. Run degraded; do NOT
  mint a replacement. An addon write over a secret it could not read is refused
  (`SecretOverwriteRefusedError`), so "absent → mint → save" cannot loop.
- **`''` never clears a secret.** To forget one: `this.clearSecrets(['key'])`.

## 4. Never through the environment or argv — files for children

- **No secret reaches any process through its environment** — not an addon
  credential, not the session signing key, not a node token, not "an
  optional token for power users" (D797 removed `HF_TOKEN`,
  `CAMSTACK_SECRET_KEY` and the like). A credential is a declared field, read
  from your config.
- The hub's own secrets live in the keychain under owner `system`; an agent's
  identity is its mesh certificate and key in its own `agent.json` (0600). The keychain master key
  comes from `keychain.keyFile` in `config.yaml`, the desktop app's OS
  keychain, or the default key file — never an env var (D788).
- **A child process that needs a credential gets an owner-only FILE**: a fresh
  `0700` temp dir, the value written with `mode: 0o600`, the PATH passed on
  argv (`--auth-key=file:<path>`, `--token-file <path>`), the dir removed when
  the child settles — success or failure. Worked example:
  `packages/addon-tailscale/src/auth-key-file.ts`; also
  `packages/addon-cloudflare/src/tunnel/cloudflared-invocation.ts`.
- A URL with embedded credentials is a secret on argv too: build it for the
  child from a file or a pipe the child reads, never from a string you log.
- Client-side developer tooling is different: the `camstack` CLI's
  `$CAMSTACK_TOKEN` / `--token-file` and `scripts/hub/hub.mjs`'s credential chain
  (`--token-file`, then the `camstack login` session) are a developer's own credentials on their own machine,
  not server-side secrets.

## 5. Logs, fixtures, the repository

- A value your addon resolved from the keychain is scrubbed from its logs
  automatically; a message you BUILD with it (an error string from a child,
  `Command failed: …`) is your job — pass it through a scrubber.
- Recorded fixtures never carry a live camera credential
  (`scripts/check-no-credential-urls-in-fixtures.ts`).
- No OAuth client secret in a publishable package
  (`scripts/check-no-client-secrets.ts`) and no private key of any kind
  (`scripts/check-no-service-account-keys.ts`) — every package is public on
  npm. A secret that must exist server-side for a public integration lives
  behind a broker, not in source.
- A secret that was ever committed or published is rotated, not just deleted.

## 6. In the UI

The secret field is `SecretFieldControl` (`packages/ui-library/src/composites/config-secret-field.tsx`) plus
`PasswordInput` from the ui-library; the admin form shows "set", never the
value (D789), and a reveal happens in a dialog. Details: `camstack-ui-admin`.

## 7. Guards — run the ones you touched

```bash
npx tsx scripts/check-secret-fields-declared.ts
npx tsx scripts/check-no-raw-secret-read.ts
npx tsx scripts/check-no-client-secrets.ts
npx tsx scripts/check-no-service-account-keys.ts
npx tsx scripts/check-no-credential-urls-in-fixtures.ts
```

Operators moving an old hub's plaintext into the keychain use the one-off
`scripts/ops/keychain-migrate-hub.mjs`; the product ships no migration code.
A lost master key is recovered with the `RESET_KEYCHAIN` trigger file
(D799, `docs/architecture/secrets-keychain.md` §"A lost master key").

## 8. Done-gate — paste it before "done"

```
SECRETS DONE — <addon / field>
declared:  <field → password | secret:true | .meta({secret:true}) | secretStatePaths entry>
read path: <this.config / resolved reads; marker (unavailable) handled as: …>
children:  <0600 file via <helper> | no child needs it>
env/argv:  none — <grep result for the value's variable on spawn calls>
guards:    <the commands above and their result>
```
