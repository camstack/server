# @camstack/addon-auth

Authentication bundle — OIDC and WebAuthn/passkey. Multi-entry npm package shipping 2 addons under a single bundle; each addon keeps its own id, capabilities, and runner.

## What it does

- **OpenID Connect** (`auth-oidc`): Standards-compliant OIDC authentication. Configure issuer URL + client credentials to enable SSO via Google, Microsoft, Okta, Keycloak, etc. In-process on hub root — pure HTTP/JWT, no native deps.
  - Node placement: `any-node`, runner group `auth`.
  - Capabilities: `auth-provider`, `addon-routes`, `login-method`, `oidc-connections`.
- **Passkey** (`auth-webauthn`): Phishing-resistant passwordless 2FA via the WebAuthn standard. Users enroll a passkey (Touch ID, Windows Hello, YubiKey, …) and authenticate with the browser's native prompt — no codes to type.
  - Node placement: `any-node`, runner group `auth`.
  - Capabilities: `user-passkeys`, `addon-widgets-source`, `login-method`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `react`, `react-dom`.
- A CamStack hub. An agent is used only when the placement above allows it.

