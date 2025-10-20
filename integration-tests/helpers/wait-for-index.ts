/**
 * Helper functions to wait for index synchronization in a deterministic way
 * by directly checking the index_data table instead of using arbitrary timeouts.
 */

export interface WaitForIndexOptions {
  timeout?: number
  pollInterval?: number
}

/**
 * Wait for specific entities to be indexed by checking the index_data table directly.
 * This is more reliable than using arbitrary timeouts.
 */
export async function waitForIndexedEntities(
  dbConnection: any,
  entityName: string,
  entityIds: string[],
  options: WaitForIndexOptions = {}
): Promise<void> {
  const { timeout = 120000, pollInterval = 100 } = options
  const startTime = Date.now()

  // Normalize the entity name to match partition table naming convention
  const normalizedName = entityName.toLowerCase().replace(/[^a-z0-9_]/g, "_")
  const partitionTableName = `cat_${normalizedName}`

  while (Date.now() - startTime < timeout) {
    try {
      // Query the index_data table to check if all entities are indexed
      const result = await dbConnection.raw(
        `SELECT id FROM index_data WHERE name = ? AND id = ANY(?) AND staled_at IS NULL`,
        [entityName, entityIds]
      )

      const indexedIds = result.rows
        ? result.rows.map((row: any) => row.id)
        : result.map((row: any) => row.id)

      // Check if all expected entities are indexed in index_data
      const allIndexed = entityIds.every((id) => indexedIds.includes(id))

      if (!allIndexed) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval))
        continue
      }

      // Also check if data is replicated to the partition table
      const partitionResult = await dbConnection.raw(
        `SELECT id FROM ${partitionTableName} WHERE id = ANY(?)`,
        [entityIds]
      )

      const partitionIds = partitionResult.rows
        ? partitionResult.rows.map((row: any) => row.id)
        : partitionResult.map((row: any) => row.id)

      // Check if all expected entities are in the partition table
      const allInPartition = entityIds.every((id) => partitionIds.includes(id))

      if (allInPartition) {
        return
      }
    } catch (error) {
      // Continue polling on database errors
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval))
  }

  throw new Error(
    `Entities [${entityIds.join(
      ", "
    )}] of type '${entityName}' were not fully replicated to partition table within ${timeout}ms`
  )
}
