---
name: hub-access
description: Reach a Dominevo hub from a client tool — the CLI, `dominevo deploy`, the MCP servers, an operator script, a benchmark or probe. There is ONE credential, the `dominevo login` session; this skill says how to log in once, how the address is found, how the session renews, the admin tier, what a 401 or an expired session means, and why an agent never logs in itself. Use for "how do I authenticate to the hub", "not logged in", "401 from the hub", "where does the token live", "my script needs a token", "headless service needs access".
---

# Reaching a hub

Every client tool reaches a hub the same way: the **`dominevo login` session**.
There is no token flag, no token file, no `$CAMSTACK_TOKEN`, no rc file, and no
password in a script. A tool that needs a credential asks the one resolver; a
tool that needs a second way in is a bug to fix, not an exception to grant
(D1101, enforced by `scripts/check-single-client-login.ts`).

## 1. Log in once

```bash
dominevo login <host>        # interactive: the operator types it, once per hub
```

The session is a file under `~/.camstack/` named for the hub address. It holds a
short-lived token and the refresh token that renews it. **Never read, print or
copy that file** — not in a script, not in a log, not in a prompt.

A headless service (a CI box, a systemd unit, a container) logs in **once**, by
a person, on that machine; the saved session then renews itself on use. It does
not need a long-lived token on disk, because the session is the long-lived part.

## 2. Which hub

The address is never a secret and may come from, in this order: the tool's
`--server` option, `CAMSTACK_HUB_URL` / `CAMSTACK_SERVER`, a checkout's
`scratchpad/.hub-url`, then the hub of the saved session. A bare host is
completed to the default port.

## 3. In code

| You write | Use |
| --- | --- |
| A package (CLI command, MCP, executor) | `resolveFreshCredentials` / `connectHub` from `@dominevo/develop` |
| An operator script in `scripts/` | `resolveHubAuth({ server })` from `scripts/hub/credentials.mjs`, or call `scripts/hub/hub.mjs` |
| A shell script | wrap `dominevo deploy` / `scripts/hub/hub.mjs`; never `curl` with a token |

`connectHub` renews an expiring session before the call and once more after a
401, so a long run does not die mid-way. Nothing in a tool reads a token from
the environment, argv or a file of its own.

## 4. Admin tier

Most reads work with any login. Writes that change the hub (apply a review plan,
deploy a server update, migrate secrets) need an **admin** login. The resolver
reports the tier; when it is not admin the tool says so and prints the exact
`dominevo login` command. If the tier could not be confirmed (the hub did not
answer), the tool says that instead of guessing "not admin".

## 5. When it fails

| Symptom | Meaning | Do |
| --- | --- | --- |
| `Not logged in to <hub>` | no saved session for that address | `dominevo login <host>` |
| 401 after the renewal | the refresh token was revoked or the user removed | log in again |
| `--token` / `--token-file` "was removed" | an old command line | drop the flag; log in |
| certificate error | self-signed hub | name its CA (`CAMSTACK_HUB_CA_FILE`); never switch verification off |

## 6. Agents never log in themselves

A coding agent does not type a password, does not run `dominevo login` on the
operator's behalf, and does not look for a credential. It uses the session the
operator already created, through the tools above. If there is none, it stops
and asks the operator to log in. (A dev hub with named test users is the only
place an agent may sign in, and only as the project instructions say.)

## Not this

An agent's **join token** (`dominevo agent --token`, the cluster pairing code)
is a node's identity at first pairing, not a client login; it is a different
mechanism and unaffected.
