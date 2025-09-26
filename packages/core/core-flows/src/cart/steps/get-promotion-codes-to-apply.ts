import type { IPromotionModuleService } from "@medusajs/framework/types"
import {
  MedusaError,
  Modules,
  PromotionActions,
} from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

/**
 * The details of the promotion codes to apply on a cart.
 */
export interface GetPromotionCodesToApplyStepInput {
  /**
   * The cart containing items and shipping methods.
   */
  cart: {
    /**
     * The cart's items and the promotion adjustments applied to them.
     */
    items?: { adjustments?: { code?: string }[] }[]
    /**
     * The cart's shipping methods and the promotion adjustments applied to them.
     */
    shipping_methods?: { adjustments?: { code?: string }[] }[]
  }
  /**
   * the promotion codes to be applied to the cart.
   */
  promo_codes?: string[]
  /**
   * Whether to add, remove, or replace promotion codes.
   */
  action?:
    | PromotionActions.ADD
    | PromotionActions.REMOVE
    | PromotionActions.REPLACE
}

/**
 * The promotion codes to apply on the cart.
 *
 * @example ["PRO10", "SHIPFREE", "NEWYEAR20"]
 */
export type GetPromotionCodesToApplyStepOutput = string[]

export const getPromotionCodesToApplyId = "get-promotion-codes-to-apply"
/**
 * This step retrieves the promotion codes to apply on a cart.
 *
 * @example
 * const data = getPromotionCodesToApply(
 *   {
 *     cart: {
 *       items: [
 *         {
 *           adjustments: [{ code: "PROMO10" }]
 *         }
 *       ],
 *       shipping_methods: [
 *         {
 *           adjustments: [{ code: "SHIPFREE" }]
 *         }
 *       ]
 *     },
 *     promo_codes: ["NEWYEAR20"],
 *     action: PromotionActions.ADD
 *   },
 * )
 */
export const getPromotionCodesToApply = createStep(
  getPromotionCodesToApplyId,
  async (data: GetPromotionCodesToApplyStepInput, { container }) => {
    const { promo_codes = [], cart, action = PromotionActions.ADD } = data
    const { items = [], shipping_methods = [] } = cart
    const promotionService = container.resolve<IPromotionModuleService>(
      Modules.PROMOTION
    )

    const adjustmentCodes: string[] = []
    items.concat(shipping_methods).forEach((object) => {
      object.adjustments?.forEach((adjustment) => {
        if (adjustment.code) {
          adjustmentCodes.push(adjustment.code)
        }
      })
    })

    const promotionCodesToApply: Set<string> = new Set(adjustmentCodes)

    if (action === PromotionActions.REMOVE) {
      promo_codes.forEach((code) => promotionCodesToApply.delete(code))
    }

    if (action === PromotionActions.REPLACE) {
      promotionCodesToApply.clear()
    }

    if (
      action === PromotionActions.ADD ||
      action === PromotionActions.REPLACE
    ) {
      const validPromoCodes: Set<string> = new Set(
        promo_codes.length
          ? (
              await promotionService.listPromotions(
                { code: promo_codes },
                { select: ["code"] }
              )
            ).map((p) => p.code!)
          : []
      )

      promo_codes.forEach((code) => {
        if (!validPromoCodes.has(code)) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `The promotion code ${code} is invalid`
          )
        }
        promotionCodesToApply.add(code)
      })
    }

    return new StepResponse(
      Array.from(promotionCodesToApply) as GetPromotionCodesToApplyStepOutput
    )
  }
)
