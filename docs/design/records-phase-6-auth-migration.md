# Records phase 6 — authentication

Operator runbook for §2.8 of `records-api-plan.md`. **High risk:** a mistake can lock
everyone out. Do not auto-drop legacy tables.

## Before hub restart

1. Mint and test a spare admin token (`csa_…`) on the **old** build.
2. `records-adopt.ts --snapshot --owner local-auth` (and `auth-webauthn`, `core-auth`,
   `system-config` when those owners are wired).
3. Stop the owning addon(s), deploy the new build, `--copy` then `--copy --apply
   --owner-stopped`, verify hashes, start.

## Owners and kinds

| Owner | Legacy tables | Record kinds |
| --- | --- | --- |
| `local-auth` | `users`, `api_keys`, `scoped_tokens`, `admin_tokens`, `login_sessions`, `login_session_cutoffs`, `oauth_sessions`, `user_totp`, `user_external_identities`, `device_credentials`, `auth_audit` | see `localAuthRecordKinds` |
| `auth-webauthn` | `auth-webauthn:user_passkeys`, `auth-webauthn:user_passkey_prefs` | `passkeys`, `passkey-prefs` |
| `core-auth` | `share_view_tokens` | `share-view-tokens` |
| `system-config` | `mesh_node_certificates`, `agent_https_names` | `mesh-node-certificates`, `agent-https-names` |

TOTP seeds adopt as keychain markers (`user-totp.secret` meta); run `migrateRawSecrets`
for inline seeds before cutover.

## Drop (operator only)

After 14+ days and verified counts, per table:

`storageAdmin.dropCollection { collection, expectRows }` — **never** the scheduled orphan
job for auth tables.

## Rollback

Reinstall the previous addon/closure; legacy tables untouched for 14 days. Writes after
cutover are lost unless `--reverse` (config kinds only).
