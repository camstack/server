# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Provider error text now refers to the instance test instead of the retired storage test call

## [1.2.145] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.144] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.143] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.142] - 2026-10-27

### Added

- Remote Storage: Remote storage providers (SFTP, S3, WebDAV, SMB) — unifies remote backends behind the storage-provider cap.
- Provides the addons SFTP Storage, S3 Storage, WebDAV Storage, SMB Storage.
