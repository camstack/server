# Authentication

Authentication bundle — OIDC and WebAuthn/passkey. Multi-entry npm package shipping 2 addons under a single bundle; each addon keeps its own id, capabilities, and runner. OIDC SSO and WebAuthn/passkey login providers.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-auth` on npm.

## What it provides

- **OpenID Connect** (`auth-oidc`): Standards-compliant OIDC authentication. Configure issuer URL + client credentials to enable SSO via Google, Microsoft, Okta, Keycloak, etc. In-process on hub root — pure HTTP/JWT, no native deps. Category: system.
  - Capabilities: `auth-provider`, `addon-routes`, `login-method`, `oidc-connections`.
- **Passkey** (`auth-webauthn`): Phishing-resistant passwordless 2FA via the WebAuthn standard. Users enroll a passkey (Touch ID, Windows Hello, YubiKey, …) and authenticate with the browser's native prompt — no codes to type. Category: system.
  - Capabilities: `user-passkeys`, `addon-widgets-source`, `login-method`.

## Requirements

- Placement: default placement (runner group `auth`).
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/authentication.md](https://github.com/camstack/server/blob/main/docs/architecture/authentication.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
