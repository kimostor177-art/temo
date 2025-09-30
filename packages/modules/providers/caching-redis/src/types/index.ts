export interface RedisCacheModuleOptions {
  /**
   * TTL in milliseconds
   */
  ttl?: number
  /**
   * Connection timeout in milliseconds
   */
  connectTimeout?: number
  /**
   * Lazyload connections
   */
  lazyConnect?: boolean
  /**
   * Connection retries
   */
  retryDelayOnFailover?: number
  /**
   * Key prefix for all cache keys
   */
  prefix?: string
  /**
   * Minimum size in bytes to compress data (default: 1024)
   */
  compressionThreshold?: number
}
