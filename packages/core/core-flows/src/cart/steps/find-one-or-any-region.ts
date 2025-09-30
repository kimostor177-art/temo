import {
  IRegionModuleService,
  IStoreModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { MedusaError, Modules, useCache } from "@medusajs/framework/utils"
import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"

/**
 * The details of the region to find.
 */
export type FindOneOrAnyRegionStepInput = {
  /**
   * The ID of the region to find.
   */
  regionId?: string
}

async function fetchRegionById(regionId: string, container: MedusaContainer) {
  const service = container.resolve<IRegionModuleService>(Modules.REGION)

  const args = [
    regionId,
    {
      relations: ["countries"],
    },
  ] as Parameters<IRegionModuleService["retrieveRegion"]>

  return await useCache(async () => service.retrieveRegion(...args), {
    container,
    key: args,
  })
}

async function fetchDefaultStore(container: MedusaContainer) {
  const storeModule = container.resolve<IStoreModuleService>(Modules.STORE)

  return await useCache(async () => storeModule.listStores(), {
    container,
    key: "find-one-or-any-region-default-store",
  })
}

async function fetchDefaultRegion(
  defaultRegionId: string,
  container: MedusaContainer
) {
  const service = container.resolve<IRegionModuleService>(Modules.REGION)

  const args = [
    { id: defaultRegionId },
    { relations: ["countries"] },
  ] as Parameters<IRegionModuleService["listRegions"]>

  return await useCache(async () => service.listRegions(...args), {
    container,
    key: args,
  })
}

export const findOneOrAnyRegionStepId = "find-one-or-any-region"
/**
 * This step retrieves a region either by the provided ID or the first region in the first store.
 */
export const findOneOrAnyRegionStep = createStep(
  findOneOrAnyRegionStepId,
  async (data: FindOneOrAnyRegionStepInput, { container }) => {
    if (data.regionId) {
      try {
        const region = await fetchRegionById(data.regionId, container)
        return new StepResponse(region)
      } catch (error) {
        return new StepResponse(null)
      }
    }

    const [store] = await fetchDefaultStore(container)

    if (!store) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Store not found")
    }

    const [region] = await fetchDefaultRegion(
      store.default_region_id!,
      container
    )

    if (!region) {
      return new StepResponse(null)
    }

    return new StepResponse(region)
  }
)
