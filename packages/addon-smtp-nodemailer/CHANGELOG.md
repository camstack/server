# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Shown as "Email (SMTP)" (was "SMTP Email (Nodemailer)").

## [1.2.142] - 2026-10-27

### Added

- Email (SMTP): SMTP email provider addon for CamStack — wraps `nodemailer` and registers a `smtp-provider` cap collection entry. Used by notifier addons.
- Provides the addon Email (SMTP).
