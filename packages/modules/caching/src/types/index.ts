import type {
  Constructor,
  ICachingStrategy,
  IEventBusModuleService,
  Logger,
  ModuleProviderExports,
  ModuleServiceInitializeOptions,
} from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { default as CacheProviderService } from "../services/cache-provider"

export const CachingDefaultProvider = "default_provider"
export const CachingIdentifiersRegistrationName = "caching_providers_identifier"

export const CachingProviderRegistrationPrefix = "lp_"

export type InjectedDependencies = {
  cacheProviderService: CacheProviderService
  hasher: (data: string) => string
  logger?: Logger
  strategy: Constructor<ICachingStrategy>
  [CachingDefaultProvider]: string
  [Modules.EVENT_BUS]: IEventBusModuleService
}

export type CachingModuleOptions = Partial<ModuleServiceInitializeOptions> & {
  /**
   * The strategy to be used. Default to the inbuilt default strategy.
   */
  // strategy?: ICachingStrategy
  /**
   * Time to keep data in cache (in seconds)
   */
  ttl?: number
  /**
   * Providers to be registered
   */
  providers?: {
    /**
     * The module provider to be registered
     */
    resolve: string | ModuleProviderExports
    /**
     * If the provider is the default
     */
    is_default?: boolean
    /**
     * The id of the provider
     */
    id: string
    /**
     * key value pair of the configuration to be passed to the provider constructor
     */
    options?: Record<string, unknown>
  }[]
}
