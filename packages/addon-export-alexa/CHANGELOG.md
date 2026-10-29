# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.175] - 2026-10-29

### Changed

- Actions can be exported to Alexa as scenes: saying the scene name runs the action (admin links only).

## [1.2.174] - 2026-10-29

### Changed

- Alexa shows the doorbell camera sooner after a press: the stream starts warming up when the press is posted

## [1.2.173] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.172] - 2026-10-27

### Changed

- Shown as "Alexa Export".

## [1.2.171] - 2026-10-27

### Added

- Alexa Export: Alexa Smart Home Skill export — hub-side OAuth provider + directive handler. The companion AWS Lambda forwards Alexa directives to this addon's /addon/export-alexa/directive endpoint.
- Provides the addon Alexa Export.
