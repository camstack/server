# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The setup window hides the hub address and port unless Manual is chosen, shows the real default agent name, and names the right place on the hub to pair
- The agent starts with a generous default heap ceiling (RAM/4 between 1.5 and 4 GB; CAMSTACK_AGENT_HEAP_MB overrides)
- The agent app now takes its Node launch arguments (heap ceiling, allocator) from the server closure instead of a built-in formula
- Install update & restart now quits and relaunches on the new version instead of only hiding the window.
- The app publishes its version and update state to its node and installs a downloaded update when the hub asks.
- macOS: the desktop app now re-asks the native updater when a downloaded update was never staged, and logs why an install request or a quit install did nothing
- The desktop shell force-kills a node that outlives an update restart, recording the last child output and a stack sample.

### Fixed

- The desktop app now quits cleanly on SIGTERM/SIGINT and force-kills a node that announces shutdown but never exits, with a trail in shell.log

## [0.1.0] - 2026-10-27

### Added

- CamStack Desktop: CamStack — single desktop app (hub or agent, chosen at first run).
