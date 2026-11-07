# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Alexa speak targets are created and edited through the instance form only

## [0.2.194] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.2.193] - 2026-11-06

### Changed

- Notification targets are instances of the notification function: Telegram, Home Assistant, Alexa and the rest keep their ids, switches and secrets, and rules naming them keep dispatching

## [0.2.192] - 2026-11-06

### Changed

- Removed the broker-select field type; every broker link is now an instance-select field on the one link primitive
- Removed the deprecated broker-named in-use helpers; a delete refused for a linked instance is the one InstanceInUseError
- Reads the instance switch through the shared isInstanceEnabled helper; behaviour unchanged
- An Echo's volume and Do Not Disturb now change on screen at once and go back only if Amazon refuses; the media-player card shows what is playing for every source, and shuffle and repeat work (repeat one is not offered).
- Echo state now follows Amazon's push updates: volume, playback and online changes show within seconds, and the 30 s poll slows to 5 minutes while the push channel is up and returns to 30 s when it drops.

## [0.2.191] - 2026-11-06

### Changed

- Echo notification targets pick their Amazon account through the shared instance picker

## [0.2.190] - 2026-11-06

### Changed

- Alexa accounts are served as instances next to the integrations, so the Brokers section reads them from the shared instances list
- Deleting an Alexa account is refused while an integration or an Echo target still uses it, on the instances page
- An Alexa integration now only names the Alexa account it uses; the account and its sign-in are edited on the Brokers page, and an account still used by an integration or an Echo target cannot be removed

## [0.2.189] - 2026-11-05

### Changed

- The integration form is declared as the instance form (the connection form); accounts and their stored values are unchanged.
- The Alexa account form no longer shows the cookie blob and refresh token; they stay set by the sign-in and a form save cannot overwrite them
- Echo volume and play commands no longer arrive minutes late: commands go ahead of polls, a repeated volume change keeps only the newest, a call that cannot start in time is dropped, and Amazon back-off is logged

## [0.2.188] - 2026-11-05

### Changed

- Amazon sign-in and token renewal no longer depend on the alexa-cookie library; existing accounts keep working without signing in again

## [0.2.187] - 2026-11-05

### Fixed

- The integration-settings drop no longer refuses on an Alexa account; its legacy broker link is carried onto the broker record first

## [0.2.186] - 2026-11-05

### Changed

- An Alexa integration links to its account through the account record

## [0.2.185] - 2026-11-04

### Changed

- Alexa starts without waiting for the first appliance list and state poll, so a large account no longer exceeds the runner init budget during an update
- Alexa broker migrations no longer read as 'skipped-newer' (and no false 'Database is newer' alert) after the addon boots

## [0.2.184] - 2026-11-04

### Changed

- The integration states its role (devices, services or both) to the Integrations page

## [0.2.183] - 2026-11-04

### Changed

- Alexa accounts are listed on the instances page with their sign-in; their stored account is flattened once at start-up (same ids and cookies), and the macDms secret now lives in the keychain.

## [0.2.182] - 2026-11-03

### Changed

- An idle Echo shows its volume and mute again (the volume list is read correctly)

## [0.2.181] - 2026-11-03

### Changed

- An idle Echo now shows its real volume and mute (read once per account from Amazon's volume list); volume up and down step the level by 10.

## [0.2.180] - 2026-11-03

### Changed

- Echo devices answer the new media-player step and power methods as unsupported

## [0.2.179] - 2026-11-02

### Changed

- Sign-in mode selector is back on the Alexa broker dialog: Device code (default) or Guided login (proxy); switching never touches a stored session

## [0.2.178] - 2026-11-02

### Changed

- An Amazon Echo can be adopted as a media player: play, pause, next, previous and volume, with its state read every 30 seconds, plus a Do Not Disturb switch

## [0.2.177] - 2026-11-01

### Changed

- An Echo now speaks notifications at its current volume: the per-target volume setting is gone, and stored targets are cleaned of it on the next start

## [0.2.176] - 2026-11-01

### Changed

- Alexa announcements and speech work again, and a failed state poll no longer turns a signed-in broker to error (states are polled in chunks of 50)

## [0.2.175] - 2026-11-01

### Changed

- Alexa cookie login: the login proxy no longer forwards Amazon's upgrade-insecure-requests directive, which stopped the page from completing over http
- Echo sign-in through a broker now uses the cookies Amazon returns for the token directly, and a failed sign-in names its step

## [0.2.174] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.173] - 2026-11-01

### Changed

- The Amazon device-code sign-in's refresh token and session cookie are declared secret
- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.172] - 2026-10-31

### Changed

- Alexa shows an error instead of 'connected' when polling Amazon keeps failing, with the HTTP status in the log.
- Alexa: quiet vs announce is now decided per notification (a silent notification is spoken quietly, any other announces); the per-target Mode setting is gone and a stored one is ignored.

## [0.2.171] - 2026-10-30

### Changed

- Notification targets pick a broker and list their options inside the add/edit form; the page-wide Find devices dialog is gone

## [0.2.170] - 2026-10-30

### Changed

- Alexa accounts now connect after a device-code sign-in (the broker no longer errors with getAuthenticationDetails), and the Amazon login offers only the device-code sign-in

## [0.2.169] - 2026-10-30

### Changed

- Alexa: sign in with a code at amazon.<tld>/code (device code); the proxy login stays as an option

## [0.2.168] - 2026-10-29

### Changed

- Alexa sign-in trace now records the proxy's first request to Amazon (parameter names and whether OAuth parameters are present) and the browser family, to diagnose logins that end without an authorization code.

## [0.2.167] - 2026-10-29

### Changed

- Amazon sign-in logs which parameters each redirect carries (names only) to diagnose a sign-in that ends without access.

## [0.2.166] - 2026-10-29

### Changed

- Amazon sign-in now finishes when Amazon's final maplanding redirect passes through the hub login proxy, and ends on the CamStack result page

## [0.2.165] - 2026-10-28

### Changed

- The Alexa sign-in keeps Amazon's session cookie through the hub proxy (the email step still fails upstream, tracked separately)

## [0.2.164] - 2026-10-28

### Changed

- Alexa sign-in opens the login page of the chosen Amazon region and in its language, and no longer fails right after entering the email
- Echo speech mode and volume can be set per notification rule; the Speak on Echo page is gone, Echo targets are managed under Notifications, Targets.

## [0.2.163] - 2026-10-28

### Changed

- The Amazon login proxy logs each step it takes (without secrets), and the start log names the region

## [0.2.162] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.161] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [0.2.160] - 2026-10-28

### Changed

- The Amazon sign-in button opens the login again; the sign-in page now lives under a path no addon route shares

## [0.2.159] - 2026-10-27

### Added

- The Amazon sign-in now opens through the hub over HTTPS; the login proxy host setting and the published port are no longer needed.

## [0.2.158] - 2026-10-27

### Fixed

- Alexa sign-in follows Amazon's current login pages

## [0.2.157] - 2026-10-27

### Fixed

- Amazon sign-in for the Alexa broker can be retried after a cancelled attempt, and the sign-in link now uses the hub's LAN address from the Network page instead of the first network interface
- Alexa sign-in follows Amazon's current login pages (library update)

## [0.2.156] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.155] - 2026-10-27

### Changed

- Echo speech signs in as the import broker (its refresh token) instead of a
  separate Amazon login; one worker and one cookie jar per broker. The Speak
  on Echo page no longer signs in. An old standalone login migrates onto the
  single broker, or is dropped with a named state when there are none or several.
- The Alexa target form picks the Echo from the account's device list.
- The Alexa kind serves the Alexa brand mark as its icon.
