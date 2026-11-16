# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- traps_for and read_section now cover the public skill pack sections, including the integration traps; scaffold_addon accepts the integration kinds
- The model-pin census reads the pipeline orchestrator's cluster settings through the scoped settings API
- New hub_health_digest tool: the orchestrator's latest health findings
- hub_health_digest returns the per-camera runner signals
- timeline_audit: audit the Timeline events of chosen cameras over N days for missing images and recording coverage
- training_frame_candidates finds retrain-frame candidates from a camera's tracks and recordings, and training_frame_mark marks them through the retrain API (dry run first)

## [0.1.0] - 2026-10-27

### Added

- CamStack Dev MCP: Private CamStack operator MCP (camstack-dev / camstack-ops). Not published — for developing CamStack itself.
