import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * Remote-storage bundle — 4 entries (sftp/s3/webdav/smb storage providers).
 *
 * extraExternals lifts AWS SDK + webdav + samba-client into the
 * framework-external set so they stay as runtime resolves. ssh2 already in
 * COMMON_NATIVE_DEPS (Phase E preset).
 *
 * `samba-client` must stay external: it `require`s `execa`, and it is only
 * useful alongside the `smbclient` BINARY, which the runner installs from the
 * manifest's `systemDependencies` — bundling the JS wrapper would not bring
 * the binary with it and would only make the dependency harder to see.
 */
export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'sftp.addon': 'src/sftp.addon.ts',
    's3.addon': 'src/s3.addon.ts',
    'webdav.addon': 'src/webdav.addon.ts',
    'smb.addon': 'src/smb.addon.ts',
  },
  externals: 'self-contained',
  extraExternals: ['@aws-sdk/client-s3', '@aws-sdk/lib-storage', 'webdav', 'samba-client'],
})
