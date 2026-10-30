---
title: addon-import-alexa — package notes
covers:
  - packages/addon-import-alexa/**
---

# addon-import-alexa — package notes

One Amazon account is one broker. Device import (alexa-remote2) and Speak on
Echo (`alexapy` 1.29.20, long-lived Python workers) both live on it; the
operator signs in once, on the broker (Integrations, Alexa).

| | Device import | Speak on Echo |
| --- | --- | --- |
| What it does | Import smart-home appliances and poll their state | Read a notification aloud on Echo devices and groups |
| Secret | `cookie` / `refreshToken` on the broker | the broker's refresh token (read, never copied) plus a derived cookie jar per broker (`speak-sessions` record, secret field) |
| Where it is set up | Integrations, Alexa, plus the login proxy | nowhere: Notifications, Targets, kind Alexa; a rule can override mode and volume per notification |

The official Alexa skill (`addon-export-alexa`) is a separate thing. It
publishes CamStack devices to Amazon and cannot carry arbitrary text. See
[D949](../decisions/adr-0949-echo-speech-signs-in-as-an-import-broker.md).

## The worker

`python/alexa_worker.py` is spawned once per broker. Requests are one JSON
object per stdin line (`login_broker`, `devices`, `speak`, `announce`,
`session_status`) and one JSON object per stdout line. Logs go to stderr. The
refresh token and the cookie jar are owner-only files (mode 0600); the JSON
names the paths and never contains the secret.

`login_broker` exchanges the broker's refresh token for cookies under the app
name that token was registered with, then lets `alexapy` log in with them.
Both libraries make the same `/ap/exchangetoken/cookies` call; the exchange
against Amazon itself was not exercised in this repo.

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

## Targets

The Alexa kind (`alexa-echo`, brand mark served at
`/addon/import-alexa/icons/alexa-echo`) builds its form from the accounts'
own Echo lists: a broker select (the Amazon account) and an Echo select
discovered from that broker, labelled name, room, family. Saving pins the
account on the target.

A sign-in the broker has not made shows as a failed probe. The old standalone
login (password, one-time code), its migration and the Speak on Echo page are
gone; Echo targets are stored under `echoTargets` in the addon settings.

The kind declares `mode` and `volume` as delivery parameters
([D960](../decisions/adr-0960-a-notifier-declares-its-delivery-parameters-and-a-rule-offers-them.md)).
A rule that addresses an Echo target offers them; the rule's value wins over
the target's saved one for that send.

## Latency

There is no live measurement against Amazon in this repo. On a hub, the wait
from the notification dispatch log line to the worker's `speak` response is
the time until Alexa accepted the utterance. Hearing the speaker is that
interval plus Amazon's own playback, which this process does not observe.

## Placement

The provider stays in this addon because the account is the unofficial one.
`instanceMode` stays `multiple`; each broker has its own worker, so two
brokers for the same Amazon account would speak the same sentence twice.
