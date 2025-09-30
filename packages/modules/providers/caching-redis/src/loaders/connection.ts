import type {
  InternalModuleDeclaration,
  LoaderOptions,
  ModulesSdkTypes,
} from "@medusajs/framework/types"
import { RedisCacheModuleOptions } from "@types"
import Redis from "ioredis"

export default async (
  {
    container,
    logger,
    options,
  }: LoaderOptions<
    (
      | ModulesSdkTypes.ModuleServiceInitializeOptions
      | ModulesSdkTypes.ModuleServiceInitializeCustomDataLayerOptions
    ) & { logger?: any }
  >,
  moduleDeclaration?: InternalModuleDeclaration
): Promise<void> => {
  const logger_ = logger || console

  const moduleOptions = (options ??
    moduleDeclaration?.options ??
    {}) as RedisCacheModuleOptions & {
    redisUrl?: string
  }

  if (!moduleOptions.redisUrl) {
    throw new Error("[caching-redis] redisUrl is required")
  }

  let redisClient: Redis

  try {
    redisClient = new Redis(moduleOptions.redisUrl!, {
      connectTimeout: 10000,
      lazyConnect: true,
      retryDelayOnFailover: 100,
      connectionName: "medusa-cache-redis",
      ...moduleOptions,
    })

    // Test connection
    await redisClient.ping()
    logger_.info("Redis cache connection established successfully")
  } catch (error) {
    logger_.error(`Failed to connect to Redis cache: ${error.message}`)
    redisClient = new Redis(moduleOptions.redisUrl!, {
      connectTimeout: 10000,
      lazyConnect: true,
      retryDelayOnFailover: 100,
      ...moduleOptions,
    })
  }

  container.register({
    redisClient: {
      resolve: () => redisClient,
    },
    prefix: {
      resolve: () => moduleOptions.prefix ?? "mc:",
    },
  })
}
