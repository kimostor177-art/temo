import { IModuleService, ModuleJoinerConfig } from "../modules-sdk"

type Providers = string[] | { id: string; ttl?: number }[]

export interface ICachingModuleService extends IModuleService {
  // Static trace methods
  // traceGet: (
  //   cacheGetFn: () => Promise<any>,
  //   key: string,
  //   tags: string[]
  // ) => Promise<any>

  // traceSet?: (
  //   cacheSetFn: () => Promise<any>,
  //   key: string,
  //   tags: string[],
  //   options: { autoInvalidate?: boolean }
  // ) => Promise<any>

  // traceClear?: (
  //   cacheClearFn: () => Promise<any>,
  //   key: string,
  //   tags: string[],
  //   options: { autoInvalidate?: boolean }
  // ) => Promise<any>

  /**
   * This method retrieves data from the cache.
   *
   * @param key - The key of the item to retrieve.
   * @param tags - The tags of the items to retrieve.
   * @param providers - Array of providers to check in order of priority. If not provided,
   * only the default provider will be used.
   *
   *  @returns The item(s) that was stored in the cache. If the item(s) was not found, null will
   *  be returned.
   *
   */
  get<T>({
    key,
    tags,
    providers,
  }: {
    key?: string
    tags?: string[]
    providers?: string[]
  }): Promise<T | null>

  /**
   * This method stores data in the cache.
   *
   * @param key - The key of the item to store.
   * @param data - The data to store in the cache.
   * @param ttl - The time-to-live (TTL in seconds) value in seconds. If not provided, the default TTL value
   * is used. The default value is based on the used Cache Module.
   * @param tags - The tags of the items to store. can be used for cross invalidation.
   * @param options - if specified, will be stored with the item(s).
   * @param providers - The providers from which to store the item(s).
   *
   */
  set({
    key,
    data,
    ttl,
    tags,
    options,
    providers,
  }: {
    key: string
    data: object
    ttl?: number
    tags?: string[]
    options?: {
      autoInvalidate?: boolean
    }
    providers?: Providers
  }): Promise<void>

  /**
   * This method clears data from the cache.
   *
   * @param key - The key of the item to clear.
   * @param tags - The tags of the items to clear.
   * @param options - if specified, invalidate the item(s) that has the value of the given
   * options stored. e.g you can invalidate the tags X if their options.autoInvalidate is false or not present.
   * @param providers - The providers from which to clear the item(s).
   *
   */
  clear({
    key,
    tags,
    options,
    providers,
  }: {
    key?: string
    tags?: string[]
    options?: {
      autoInvalidate?: boolean
    }
    providers?: string[]
  }): Promise<void>

  computeKey(input: object): Promise<string>

  computeTags(input: object, options?: Record<string, any>): Promise<string[]>
}

export interface ICachingProviderService {
  get({ key, tags }: { key?: string; tags?: string[] }): Promise<any>
  set({
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
    options?: { autoInvalidate?: boolean }
  }): Promise<void>
  clear({
    key,
    tags,
    options,
  }: {
    key?: string
    tags?: string[]
    options?: { autoInvalidate?: boolean }
  }): Promise<void>
}

export interface EntityReference {
  type: string
  id: string | number
  field?: string
}

export interface ICachingStrategy {
  /**
   * This method is called when the application starts. It can be useful to set up some auto
   * invalidation logic that reacts to something.
   *
   * @param container MedusaContainer
   * @param schema GraphQLSchema
   * @param cacheModule ICachingModuleService
   */
  onApplicationStart?(
    schema: any,
    joinerConfigs: ModuleJoinerConfig[]
  ): Promise<void>

  onApplicationPrepareShutdown?(): Promise<void>

  onApplicationShutdown?(): Promise<void>

  computeKey(input: object): Promise<string>

  computeTags(input: object, options?: Record<string, any>): Promise<string[]>
}
