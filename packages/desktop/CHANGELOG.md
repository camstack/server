# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The setup window hides the hub address and port unless Manual is chosen, shows the real default agent name, and names the right place on the hub to pair
- The agent starts with a generous default heap ceiling (RAM/4 between 1.5 and 4 GB; CAMSTACK_AGENT_HEAP_MB overrides)
- The agent app now takes its Node launch arguments (heap ceiling, allocator) from the server closure instead of a built-in formula

## [0.1.0] - 2026-10-27

### Added

- CamStack Desktop: CamStack — single desktop app (hub or agent, chosen at first run).
