import NodeCache from "node-cache"
import type { ICachingProviderService } from "@medusajs/framework/types"

export interface MemoryCacheModuleOptions {
  /**
   * TTL in seconds
   */
  ttl?: number
  /**
   * Maximum number of keys to store (see node-cache documentation)
   */
  maxKeys?: number
  /**
   * Check period for expired keys in seconds (see node-cache documentation)
   */
  checkPeriod?: number
  /**
   * Use clones for cached data (see node-cache documentation)
   */
  useClones?: boolean
}

export class MemoryCachingProvider implements ICachingProviderService {
  static identifier = "cache-memory"

  protected cacheClient: NodeCache
  protected tagIndex: Map<string, Set<string>> = new Map() // tag -> keys
  protected keyTags: Map<string, Set<string>> = new Map() // key -> tags
  protected entryOptions: Map<string, { autoInvalidate?: boolean }> = new Map() // key -> options
  protected options: MemoryCacheModuleOptions

  constructor() {
    this.options = {
      ttl: 3600,
      maxKeys: 25000,
      checkPeriod: 60, // 10 minutes
      useClones: false, // Default to false for speed, true would be slower but safer. we can discuss
    }

    const cacheClient = new NodeCache({
      stdTTL: this.options.ttl,
      maxKeys: this.options.maxKeys,
      checkperiod: this.options.checkPeriod,
      useClones: this.options.useClones,
    })

    this.cacheClient = cacheClient

    // Clean up tag indices when keys expire
    this.cacheClient.on("expired", (key: string, value: any) => {
      this.cleanupTagReferences(key)
    })

    this.cacheClient.on("del", (key: string, value: any) => {
      this.cleanupTagReferences(key)
    })
  }

  private cleanupTagReferences(key: string): void {
    const tags = this.keyTags.get(key)
    if (tags) {
      tags.forEach((tag) => {
        const keysForTag = this.tagIndex.get(tag)
        if (keysForTag) {
          keysForTag.delete(key)
          if (keysForTag.size === 0) {
            this.tagIndex.delete(tag)
          }
        }
      })
      this.keyTags.delete(key)
    }
    // Also clean up entry options
    this.entryOptions.delete(key)
  }

  async get({ key, tags }: { key?: string; tags?: string[] }): Promise<any> {
    if (key) {
      return this.cacheClient.get(key) ?? null
    }

    if (tags && tags.length) {
      const allKeys = new Set<string>()

      tags.forEach((tag) => {
        const keysForTag = this.tagIndex.get(tag)
        if (keysForTag) {
          keysForTag.forEach((key) => allKeys.add(key))
        }
      })

      if (allKeys.size === 0) {
        return []
      }

      const results: any[] = []
      allKeys.forEach((key) => {
        const value = this.cacheClient.get(key)
        if (value !== undefined) {
          results.push(value)
        }
      })

      return results
    }

    return null
  }

  async set({
    key,
    data,
    ttl,
    tags,
    options,
  }: {
    key: string
    data: object
    ttl?: number
    tags?: string[]
    options?: {
      autoInvalidate?: boolean
    }
  }): Promise<void> {
    // Set the cache entry
    const effectiveTTL = ttl ?? this.options.ttl ?? 3600
    this.cacheClient.set(key, data, effectiveTTL)

    // Handle tags if provided
    if (tags && tags.length) {
      // Clean up any existing tag references for this key
      this.cleanupTagReferences(key)

      const tagSet = new Set(tags)
      this.keyTags.set(key, tagSet)

      // Add this key to each tag's index
      tags.forEach((tag) => {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, new Set())
        }
        this.tagIndex.get(tag)!.add(key)
      })
    }

    // Store entry options if provided
    if (
      Object.keys(options ?? {}).length &&
      !Object.values(options ?? {}).every((value) => value === undefined)
    ) {
      this.entryOptions.set(key, options!)
    }
  }

  async clear({
    key,
    tags,
    options,
  }: {
    key?: string
    tags?: string[]
    options?: {
      autoInvalidate?: boolean
    }
  }): Promise<void> {
    if (key) {
      this.cacheClient.del(key)
      return
    }

    if (tags && tags.length) {
      // Handle wildcard tag to clear all cache data
      if (tags.includes("*")) {
        this.cacheClient.flushAll()
        this.tagIndex.clear()
        this.keyTags.clear()
        this.entryOptions.clear()
        return
      }

      const allKeys = new Set<string>()

      tags.forEach((tag) => {
        const keysForTag = this.tagIndex.get(tag)
        if (keysForTag) {
          keysForTag.forEach((key) => allKeys.add(key))
        }
      })

      if (allKeys.size) {
        // If no options provided (user explicit call), clear everything
        if (!options) {
          const keysToDelete = Array.from(allKeys)
          this.cacheClient.del(keysToDelete)

          // Clean up ALL tag references for deleted keys
          keysToDelete.forEach((key) => {
            this.cleanupTagReferences(key)
          })
          return
        }

        // If autoInvalidate is true (strategy call), only clear entries with autoInvalidate=true (default)
        if (options.autoInvalidate === true) {
          const keysToDelete: string[] = []

          allKeys.forEach((key) => {
            const entryOptions = this.entryOptions.get(key)
            // Delete if entry has autoInvalidate=true or no setting (default true)
            const shouldAutoInvalidate = entryOptions?.autoInvalidate ?? true
            if (shouldAutoInvalidate) {
              keysToDelete.push(key)
            }
          })

          if (keysToDelete.length) {
            this.cacheClient.del(keysToDelete)

            // Clean up ALL tag references for deleted keys
            keysToDelete.forEach((key) => {
              this.cleanupTagReferences(key)
            })
          }
        }
      }
    }
  }
}
