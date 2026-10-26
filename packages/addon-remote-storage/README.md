# @camstack/addon-remote-storage

Remote storage providers (SFTP, S3, WebDAV, SMB) — unifies remote backends behind the storage-provider cap

## What it does

- **SFTP Storage** (`sftp-storage`): SFTP / SSH-2 storage-provider for cap-mediated storage kinds (backups).
  - Node placement: `any-node`, runner group `remote-storage`.
  - Capabilities: `storage-provider`.
- **S3 Storage** (`s3-storage`): AWS S3 + S3-compatible (Minio, R2, Backblaze) storage-provider.
  - Node placement: `any-node`, runner group `remote-storage`.
  - Capabilities: `storage-provider`.
- **WebDAV Storage** (`webdav-storage`): WebDAV / Nextcloud / OwnCloud storage-provider.
  - Node placement: `any-node`, runner group `remote-storage`.
  - Capabilities: `storage-provider`.
- **SMB Storage** (`smb-storage`): SMB / CIFS storage-provider for a NAS share. Serves cap-mediated location kinds (backups); refused for recordings and event media by the storage access constraint.
  - Node placement: `any-node`, runner group `remote-storage`.
  - Capabilities: `storage-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- Runtime dependencies the node resolves: `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `webdav`, `samba-client`.
- A CamStack hub. An agent is used only when the placement above allows it.

