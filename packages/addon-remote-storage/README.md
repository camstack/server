# Remote Storage

Remote storage providers (SFTP, S3, WebDAV, SMB) — unifies remote backends behind the storage-provider cap. SFTP, S3, WebDAV and SMB storage providers. Remote backends serve cap-mediated location kinds (backups); recordings and event media are local-path kinds and are refused.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-remote-storage` on npm.

## What it provides

- **SFTP Storage** (`sftp-storage`): SFTP / SSH-2 storage-provider for cap-mediated storage kinds (backups). Category: system.
  - Capabilities: `storage-provider`.
- **S3 Storage** (`s3-storage`): AWS S3 + S3-compatible (Minio, R2, Backblaze) storage-provider. Category: system.
  - Capabilities: `storage-provider`.
- **WebDAV Storage** (`webdav-storage`): WebDAV / Nextcloud / OwnCloud storage-provider. Category: system.
  - Capabilities: `storage-provider`.
- **SMB Storage** (`smb-storage`): SMB / CIFS storage-provider for a NAS share. Serves cap-mediated location kinds (backups); refused for recordings and event media by the storage access constraint. Category: system.
  - Capabilities: `storage-provider`.

## Requirements

- Placement: default placement (runner group `remote-storage`).
- Runtime dependencies installed with the addon: `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `webdav`, `samba-client`.
- A CamStack hub. An agent is used only where the placement above allows it.

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
