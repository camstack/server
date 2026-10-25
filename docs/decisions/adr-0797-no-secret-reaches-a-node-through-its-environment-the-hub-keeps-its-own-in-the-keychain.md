---
id: D797
title: No secret reaches a node through its environment — the hub keeps its own in the keychain, an agent its bootstrap secret in agent.json
status: accepted (everything about the cluster secret — optional, generated, its hash as proof — superseded by D802, D803 and finally D857, which removed the secret; the rest stands)
date: 2026-10-08
supersedes:
applies-to:
  - packages/system/src/auth/jwt-signing-key.ts
  - packages/system/src/auth/auth-manager.ts
  - packages/system/src/auth/user-manager.ts
  - packages/system/src/builtins/local-auth/jwt-signing-key-keeper.ts
  - packages/system/src/builtins/local-auth/admin-account-boot.ts
  - packages/system/src/builtins/system-config/system-config.addon.ts
  - packages/system/src/builtins/keychain/system-held-secrets.ts
  - packages/system/src/builtins/keychain/keychain-usage.ts
  - packages/system/src/kernel/moleculer/hub-service.ts
  - packages/system/src/kernel/moleculer/broker-factory.ts
  - packages/system/src/kernel/config-schema.ts
  - packages/system/src/kernel/bootstrap-config.ts
  - packages/types/src/capabilities/keychain-admin.cap.ts
  - server/backend/src/boot/boot-config.ts
  - server/backend/src/core/moleculer/moleculer.service.ts
  - server/backend/src/agent/agent-config.ts
  - packages/addon-mqtt-broker/src/mqtt-broker.addon.ts
  - packages/addon-ai/src/runtime/hf-ref.ts
  - packages/system/src/download/model-downloader.ts
  - scripts/ops/keychain-migrate-hub.mjs
---

## Context

D783 banned secrets from argv, env and logs; D787/D788 gave the hub a keychain
and put the master key's location in configuration. Five secrets still
reached server-side code through the environment (or `config.yaml`):
`CAMSTACK_SECRET_KEY` (mqtt-broker's private `enc:v1` codec),
`CAMSTACK_CLUSTER_SECRET`, `CAMSTACK_JWT_SECRET` (also auto-written into
`config.yaml` as `auth.jwtSecret`), `CAMSTACK_ADMIN_USER` /
`CAMSTACK_ADMIN_PASS` (`auth.adminUsername` / `auth.adminPassword`), and
`HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN`. An environment is inherited by every
runner the hub forks, readable from `/proc/<pid>/environ`, shown by
`docker inspect`, and kept in the Unraid template on the flash drive.

Measured while doing this: the cluster secret was ALSO the Moleculer
namespace. The TCP transporter never checks the namespace, and UDP discovery
broadcasts it in clear (`<namespace>|<nodeID>|<port>`, every 5 s), so it
isolated nothing and published the secret on the LAN.

## Decision

The rule is operator policy for the hub, agents and addons at runtime. It does
not cover developer-only variables on the operator's Mac (`HF_TOKEN` in
`server/backend/.env` for the model upload scripts, `CAMSTACK_TOKEN` for the <!-- drift-ok -->
CLI).

1. **mqtt-broker `enc:v1` codec — retired.** The broker passwords are
   `password` fields, so the keychain already holds them like any other
   secret.
   - The codec's encryption, key generation and `CAMSTACK_SECRET_KEY` go.
   - Until the hub is migrated, a value that still starts with `enc:v1:` is
     decrypted READ-ONLY with the existing `.secret-key` file: no env, no
     re-encrypt, no write. A release therefore never takes MQTT's credentials
     away.
   - Without that file (or with the wrong key), such a value is an error
     naming the field. It is never treated as "no password", so nothing
     connects anonymously.
   - The one-off ops script (`mqtt` step, run whenever convenient after the
     release) moves the values into the keychain through the operator path.
     After that the bridge is dead code, and it is removed with the
     `.secret-key`.
2. **Cluster secret.**
   - **Hub.** It is an OPTIONAL `password` field in System → Cluster: the
     `system-config` cluster section, also drawn on the Cluster page. The
     value is kept in the keychain under owner `system`
     (`secret://system/global/clusterSecret`), and the `system-settings` row
     `cluster.clusterSecret` holds the marker. It starts empty and is never
     generated. The gate `$hub.registerNode` reads at call time:
     - no marker → `off`: any node may register, as on a hub that never had a
       secret;
     - a marker and a value → `on`: a node must present the matching hash;
     - a marker the keychain cannot answer (locked, value lost) → `unknown`:
       registration is refused with a retryable `CLUSTER_SECRET_UNAVAILABLE`.
       A locked keychain never opens the gate.
   - **Agent.** The secret is a bootstrap credential. It is entered at first
     run (the agent's status page, or the desktop setup window) and kept only
     in the agent's own `agent.json`, mode 0600. To pair an agent: Reveal the
     secret on the hub's Cluster page, copy it, enter it in the agent.
   - **Moleculer namespace.** The secret is no longer used as the namespace;
     the namespace is unset.
3. **Session signing key.** It lives in the keychain under owner `system`
   (`secret://system/global/jwtSigningKey`). `local-auth` loads it into a
   process slot that every `AuthManager` reads on each mint and verify.
   - It is generated ONLY when the keychain answers that none is stored.
   - **Locked keychain at boot (chosen behaviour).** Sessions can be neither
     minted nor verified. `JwtSigningKeyUnavailableError` is thrown: a login
     fails with that message, and a bearer check treats it as not
     authenticated. An error is logged and the load is retried every 30 s.
   - There is NO fallback: not an env var, and not a fresh random key, which
     would silently invalidate every session and every app token.
   - **No admin call is possible meanwhile.** API keys are signing-key JWTs
     too, and a `cst_` scoped token always authenticates as a non-admin, so
     it only reaches its own non-admin scopes. System → Secrets (Reset,
     Rotate) is therefore out of reach while the key is unavailable. The
     recovery path is the key file plus a restart: put the right
     `keychain.keyFile` (or the recovery copy) back and restart the hub. A
     keychain whose key is truly lost cannot be reset from the UI under this
     code; a one-shot `RESET_KEYCHAIN` trigger file is the roadmap fix.
   - The key is always "in use" for the orphan check.
   - The only way to replace it is `keychainAdmin.setSystemSecret`, which is
     audited. The ops script uses it to import the old `auth.jwtSecret` so
     existing tokens stay valid, then removes the key from `config.yaml`.
4. **Admin bootstrap.** `CAMSTACK_ADMIN_USER`, `CAMSTACK_ADMIN_PASS`,
   `auth.adminUsername` and `auth.adminPassword` are gone.
   - A fresh hub seeds `admin` / `changeme`. The first sign-in with
     `changeme` forces a password change (admin-ui `mustChangePassword`).
   - An existing user is never overwritten (D728).
   - The one-shot `RESET_ADMIN_PASSWORD` trigger file resets `admin` to
     `changeme`.
5. **Hugging Face token.** No product code reads `HF_TOKEN` /
   `HUGGING_FACE_HUB_TOKEN`. The camstack repos are public; a gated
   third-party repo is reported as `gated` and is not downloadable. No code
   path needs authentication today, so no Model Studio field was added.

The hub's boot still names any retired variable or `auth.*` key it finds
(names only, never values) and ignores it. The bootstrap `auth` section of
`config.yaml` now holds no key at all.

## Consequences

- **Ordering on the live hub.**
  - The signing-key change must not run while the keychain is locked: no
    admin credential works without the signing key (API keys are JWTs too;
    `cst_` tokens are non-admin).
  - After the release, until `import-system` restores the old key, no
    pre-release session or token authenticates. The script's admin calls
    therefore need the operator to sign in once. A pre-release `preseed`
    of the signing key (designed, not shipped) would avoid the logout; it
    is the operator's to approve.
  - The first boot of this release generates a new signing key, so every
    session is logged out once. `import-system` then restores the old key, and
    tokens minted before the upgrade become valid again.
  - mqtt-broker keeps reading its `enc:v1` values through the read-only
    bridge, so the `mqtt` step can run whenever convenient after the release.
    Nothing breaks in between.
- **The mesh is still not authenticated.** A mesh call is treated as a
  trusted admin (`createMeshTrpcContext`). The cluster secret only gates node
  registration, and the TCP transport authenticates no peer. Keep the mesh
  ports (6000/4445) off untrusted networks. Transport-level peer
  authentication is on the roadmap.
- **Desktop agent.** It no longer keeps the secret in its plaintext
  `electron-store`, and no longer passes it through env. An existing desktop
  agent re-enters the secret once in Setup (blank keeps the current one).

## Enforcement

- `jwt-signing-key.spec.ts` and `jwt-signing-key-keeper.spec.ts` cover:
  - a key is generated only on `missing`;
  - a locked keychain leaves sessions unavailable, and the load is retried;
  - nothing is written into `config.yaml`.
- `admin-password-seed.spec.ts`: `admin` / `changeme` is seeded and never
  overwritten, and `CAMSTACK_ADMIN_*` is ignored.
- `boot-config-retired-secrets.spec.ts`, `system-settings-auth-guard.spec.ts`,
  `config.service.spec.ts`: env and `config.yaml` credentials are not
  answered, and the warning names them without values.
- `cluster-secret-keeper.spec.ts`, `system-config-cluster-secret.spec.ts`,
  `cluster-secret-handshake.spec.ts`: the gate's three states, fail-closed,
  and the keychain save path.
- `keychain-service.spec.ts`: the system-held usage rules and
  `setSystemSecret`.
- `agent-cluster-secret.test.ts`: `agent.json` is written 0600.
- `model-downloader-no-token.spec.ts` and `hf-ref.spec.ts`: no
  `Authorization` header is sent.
- mqtt-broker `retired-ciphertext.spec.ts` covers the bridge:
  - an `enc:v1` value resolves with the key file present;
  - with the file absent, or a wrong key, it is an error and never "no
    password";
  - a keychain-resolved value always wins;
  - the key file is never written.
