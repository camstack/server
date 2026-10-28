# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.500] - 2026-10-28

### Changed

- AI profile editor: opening a saved profile loads its models and features automatically, and typing a listed model id applies that model's features.

## [1.2.499] - 2026-10-28

### Changed

- The AI runtimes table has a Feature column and a translated state chip, red when stopped
- Automations using the parked-object trigger or condition open read-only in the editor instead of breaking it

## [1.2.498] - 2026-10-28

### Changed

- A sign-in step that gets a non-JSON answer now names the step and HTTP status instead of a browser parse error
- AI Runtimes table: the Features column is now Feature, a stopped runtime reads Stopped (Fermo) in red, and Apple is capitalised.

## [1.2.497] - 2026-10-27

### Changed

- The broker sign-in dialog opens the provider's login page on the hub's own address and no longer warns about LAN-only links.

## [1.2.496] - 2026-10-27

### Fixed

- The broker sign-in panel shows the sign-in link, says to open it from the hub's network, and warns when this page cannot reach it

## [1.2.495] - 2026-10-27

### Fixed

- The device page's save bar appears only after you change something, and the page background fills the whole screen on phones

## [1.2.494] - 2026-10-27

### Changed

- Addon names follow the shorter product names; a page that never loads or a route that throws stays a message inside the shell; a page whose addon is absent is greyed in the nav and reads as not installed.

### Fixed

- The pet feeder card no longer repeats the desiccant; the Save footer shows only after a change; device pages fill the phone screen

## [1.2.492] - 2026-10-27

### Added

- Admin UI: Admin UI — Vite frontend build and server-side addon.
- Provides the addon Admin UI.
