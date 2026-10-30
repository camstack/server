# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.170] - 2026-10-30

### Changed

- Alexa accounts now connect after a device-code sign-in (the broker no longer errors with getAuthenticationDetails), and the Amazon login offers only the device-code sign-in
- Notification targets pick a broker and list their options inside the add/edit form; the page-wide Find devices dialog is gone

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
