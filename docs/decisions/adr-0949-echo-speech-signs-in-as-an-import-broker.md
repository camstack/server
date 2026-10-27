---
id: D949
title: Echo speech signs in as an import broker, never with a login of its own
status: proposed
date: 2026-10-27
supersedes: D947
applies-to:
  - packages/addon-import-alexa/python/**
  - packages/addon-import-alexa/src/speak/**
---

## Context

[D947](adr-0947-echo-speech-uses-a-long-lived-alexapy-worker.md) gave Speak on
Echo its own Amazon login: e-mail, password and a one-time code typed on an
addon page, kept beside the import broker's login for the same account. The
operator signed in twice, an expired code needed a second alert path, and D947
itself wrote that the two cookie jars "must not be mixed".

The question was whether the speech worker can reuse the broker's session. Read
from the installed library sources, not from memory:

- `alexa-remote2` keeps a `cookieData` registration blob. It holds the
  device-registration `refreshToken`, and `deviceAppName`, the name that
  registration was made under (`alexa-cookie2` `loginData.refreshToken`,
  `loginData.deviceAppName`). The broker already persists it after every
  refresh (`<dataDir>/<brokerId>.alexa-session.json`).
- `alexapy` 1.29.20 takes `oauth={"refresh_token": …}` in `AlexaLogin`, and
  `exchange_token_for_cookies()` posts that token to
  `/ap/exchangetoken/cookies` with `package_name=com.amazon.echo`, the very
  call `alexa-remote2` makes (`alexa-remote.js`, `source_token=<refreshToken>`,
  `source_token_type=refresh_token`). The only parameter that differs is
  `app_name`, and `alexa-cookie2` itself sends the stored `deviceAppName`.
- The cookie jars themselves are not interchangeable: `alexa-remote2` holds a
  header string, `alexapy` a pickled `aiohttp` jar. The refresh token is the
  common ground.
- `test_loggedin` compares the account e-mail with the one the login was built
  with only when that name contains `@`; a label such as the broker id skips
  the comparison.

Not proven here: the exchange against Amazon (no live login was made). The
sources agree on the call; whether Amazon accepts a token registered under
another app name is verified on first use, and a refusal is a named state,
not a silent one.

## Decision

Speech belongs to the broker that already holds the account. One Python worker
per broker id signs in with that broker's refresh token (read from the
broker's persisted session, then its stored cookie, then a bare token) and its
registered `deviceAppName`, handed to the worker as an owner-only file. The
cookie jar `alexapy` writes is kept per broker in the records store as a
secret field (`speak-sessions`), only as a restart shortcut and as the fallback
when the broker holds no token. The operator signs in once, on the broker;
the worker never prompts for a password or a code, and a broker with no
sign-in is the named state `broker-not-signed-in`.

A speech target names its broker (`brokerId`) and its Echo (`echoId`, chosen
from the account's own device list). With one broker the account is implied
and pinned on save; with several it must be chosen, and a target that names
none is refused, never guessed.

The old standalone login is retired once: with exactly one broker its jar and
its targets move onto it; otherwise the jar is dropped and the unassigned
targets are reported by name (`no-broker`, `choose-broker`).

The rest of D947 stands: one long-lived `alexapy` worker per account (not one
per message), secrets by file, a crash bound of five in sixty seconds, and a
repeated sentence, a burst and Do Not Disturb as recorded skips.

## Consequences

The Speak page no longer signs in: it shows each account's state and sends a
test. `login_start`, `login_otp`, the OTP alert and the password settings are
gone. Two brokers mean two worker processes. A token the broker refreshes is
picked up on the worker's next sign-in (every five minutes while not ready,
and on a send). If Amazon rejects the broker's token under the worker's app
name, speech reports `failed` with the reason until the broker is signed in
again.

## Enforcement

`packages/addon-import-alexa/src/__tests__/speak-controller.spec.ts` (one worker
and one session per broker, each with its own token; the migration paths),
`speak-broker-seed.spec.ts`, `alexa-speak-provider.spec.ts`, and
`python/test_alexa_gateway.py` (what the gateway hands to `alexapy`, with
`alexapy` replaced). Nothing checks the exchange against Amazon.
