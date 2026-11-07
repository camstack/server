/**
 * Storage page (System → Data → Storage). The locations are the instances of the function cap
 * `storage`, one kind per declared location type, so the page is the shared instances table with
 * the storage columns and edit-dialog block (`StorageLocationsTable`). Moving a location's footage
 * to another is the Recordings → Management → Move storage panel (`storage-migration`).
 */
import { AdminPage } from '../../components/AdminPage'
import { StorageLocationsTable } from '../../components/storage/StorageLocationsTable'

export function StoragePage() {
  return (
    <AdminPage embedded>
      <StorageLocationsTable />
    </AdminPage>
  )
}
