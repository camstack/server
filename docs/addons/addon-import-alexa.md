---
title: addon-import-alexa — package notes
covers:
  - packages/addon-import-alexa/**
---

# addon-import-alexa — package notes

Two Amazon clients live in this addon. They do not share a connection.

| | Device import | Speak on Echo |
| --- | --- | --- |
| Library | alexa-remote2 (cookie or refresh token) | `alexapy` 1.29.20, a long-lived Python worker |
| What it does | Import smart-home appliances and poll their state | Read a notification aloud on Echo devices and groups |
| Secret | `cookie` / `refreshToken` on a broker | `speak.password` and `speak.session` in the keychain |
| Page | External systems → Brokers, plus the login proxy | Administration → Speak on Echo (`/addon/import-alexa`) |

The official Alexa skill (`addon-export-alexa`) is a third thing. It publishes
CamStack devices to Amazon. It cannot carry arbitrary notification text, and
it must not be given this cookie jar. See [D947](../decisions/adr-0947-echo-speech-uses-a-long-lived-alexapy-worker.md).

## The worker

`python/alexa_worker.py` is spawned once per addon instance. Requests are one
JSON object per stdin line (`login_start`, `login_otp`, `devices`, `speak`,
`announce`, `session_status`) and one JSON object per stdout line. Logs go to
stderr. The password and the cookie jar are owner-only files (mode 0600); the
JSON names the paths and never contains the secret.

A crash restarts the process at most five times inside 60 seconds, then the
worker stays down and sends fail so the notification outbox retries. It is
never one process per message.

`python/requirements.txt` pins `alexapy==1.29.20` (Apache-2.0). The library is
not vendored. Tests mock it and must not contact Amazon.

## What a notification becomes

The rule template is rendered, then stripped to plain speech (no markup an
Echo would read aloud) and cut at 450 characters. Per Echo, the same text
inside 60 seconds is one utterance, and a different text inside 20 seconds is
skipped. Neither is queued, and neither is retried. Do Not Disturb is skipped
the same way. An offline Echo or a dead worker is a failure, so the outbox
retries.

Each delivery is recorded on the provider (`spoken`, `announced`, `collapsed`,
`rate_limited`, `dnd`, `offline`, `failed`, `empty`).

## Sign-in

Speak on Echo asks for the Amazon email, password and region (North America,
Europe, Far East). Amazon may answer with a one-time code or a captcha. A
code raises one operator alert (`import-alexa.speak-otp-required`, category
`addon.error`) until the sign-in succeeds. A captcha cannot be solved on this
page: wait and sign in again.

A test phrase speaks on the ticked devices and saves them as notification
targets (mode speak or announce, volume, respect Do Not Disturb).

## Latency

There is no live measurement against Amazon in this repo. On a hub, the wait
from the notification dispatch log line to the worker's `speak` response is
the time until Alexa accepted the utterance. Hearing the speaker is that
interval plus Amazon's own playback, which this process does not observe.

## Placement

The provider stays in this addon because the account is the unofficial one.
`instanceMode` stays `multiple` so existing broker instances are unchanged.
Each instance has its own Echo sign-in. Signing the same account into two
instances can speak the same sentence twice.
