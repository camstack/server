# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Device details list of a container shows its children without the container's name, and the primary-child picker does the same.

## [1.2.512] - 2026-10-29

### Added

- The helper creation dialog uses the full screen height; the member list scrolls instead of being cut short

### Changed

- The Actions tab shows an empty state with a create button when there are no actions, and an error instead of an endless loading message when the list cannot be read
- Creating a helper waits for the new device to appear, keeps both save buttons disabled while saving so a second click cannot create a duplicate, and a retry reuses the helper already created

## [1.2.511] - 2026-10-28

### Changed

- Agents found on the network shows a Name column

## [1.2.510] - 2026-10-28

### Changed

- An alert whose action runs a command now shows a button that runs it in place
- A finished alert no longer shows its run-action button

## [1.2.509] - 2026-10-28

### Fixed

- An agent whose pairing was left open can be resumed from Agents found on the network

## [1.2.508] - 2026-10-28

### Changed

- A pet feeder shows whether it runs on mains or on its battery

## [1.2.507] - 2026-10-28

### Changed

- The AI profile editor can turn the model's thinking off or set its effort

## [1.2.506] - 2026-10-28

### Changed

- Build: one New composed device entry with Group, Calculation and Advanced sections (a sum is now an aggregation of a readings group), and a Built as badge on every composed device.

## [1.2.505] - 2026-10-28

### Changed

- Integrations page places an integration in System or Providers from the addon's declared integrationSection, falling back to the framework-package rule
- The notification rule editor shows delivery options (such as Echo mode and volume) when a selected target supports them.
- The New Integration dialog shows the integrations like the Integrations page: bigger icons, up to three columns, Providers and System
- Integrations are listed alphabetically by name, on the page and in the New Integration dialog
- Build-your-self picks devices with the common device selector everywhere, and the helper member picker lists only compatible devices
- A temperature or humidity group can include thermostats and climate devices, read from their current temperature/humidity
- ⌘F / Ctrl+F jumps to the page's search field instead of the browser's find

## [1.2.504] - 2026-10-28

### Changed

- Integrations page splits integrations into Providers and System blocks in both the grid and the table; grid cards drop the id line and the chevron

## [1.2.503] - 2026-10-28

### Changed

- Device pages, history and helper forms read device values by their quantity name (power, level, speed) after the field rename

## [1.2.502] - 2026-10-28

### Added

- The Build page now has an Actions tab to create, run and trace actions, automations edit detection, parked-object and interval blocks with a run mode and a Runs panel, and a camera's Customize tab can link actions to it.

## [1.2.501] - 2026-10-28

### Changed

- The automation editor shows parked-object, detection and interval triggers and the parked-object condition read-only instead of dropping them

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
