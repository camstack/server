---
name: camstack-secrets
description: Handle a credential in CamStack — a password, token, API key or private key in an addon's settings, a device config, `secretStatePaths`, a token the addon mints, the hub's own secrets, or a credential a spawned child process (ffmpeg, a tunnel CLI) needs. Covers the keychain and `secret://` markers, declaring a secret by schema type, the read and clear rules, never using environment variables or argv, 0600 temp files for children, log scrubbing, the UI field, and the guards that enforce it. Use for "add a password field", "store a token", "pass a key to a subprocess", "a setting reads as { $secret }", "check-secret-fields-declared failed".
---

# Secrets (repository overlay)

The canonical PUBLIC text of this skill is `packages/develop/skills/camstack-secrets.md` (shipped with `@camstack/develop`; `camstack develop skill camstack-secrets`). **Read it first** — it holds the procedure, the traps and the done-gate, and this file does not repeat it. Below is only what is true of THIS repository. `scripts/check-skill-pack-sync.ts` keeps the two from drifting.

## Repo notes

- Guards for this skill are listed in `docs/reference/guards.md`; the five commands in the public text are the ones to run for a touched path.
- UI field details: `camstack-ui-admin`.
