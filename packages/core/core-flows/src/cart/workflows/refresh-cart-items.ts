import {
  filterObjectByKeys,
  isDefined,
  PromotionActions,
} from "@medusajs/framework/utils"
import {
  createHook,
  createWorkflow,
  transform,
  when,
  WorkflowData,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { AdditionalData, CartDTO } from "@medusajs/types"
import { useQueryGraphStep } from "../../common"
import { useRemoteQueryStep } from "../../common/steps/use-remote-query"
import { acquireLockStep, releaseLockStep } from "../../locking"
import { getVariantPriceSetsStep, updateLineItemsStep } from "../steps"
import { validateVariantPricesStep } from "../steps/validate-variant-prices"
import {
  cartFieldsForPricingContext,
  cartFieldsForRefreshSteps,
  productVariantsFields,
} from "../utils/fields"
import {
  prepareLineItemData,
  PrepareLineItemDataInput,
} from "../utils/prepare-line-item-data"
import { pricingContextResult } from "../utils/schemas"
import { refreshCartShippingMethodsWorkflow } from "./refresh-cart-shipping-methods"
import { refreshPaymentCollectionForCartWorkflow } from "./refresh-payment-collection"
import { updateCartPromotionsWorkflow } from "./update-cart-promotions"
import { updateTaxLinesWorkflow } from "./update-tax-lines"
import { upsertTaxLinesWorkflow } from "./upsert-tax-lines"

/**
 * The details of the cart to refresh.
 */
export type RefreshCartItemsWorkflowInput = {
  /**
   * The cart's ID.
   */
  cart_id: string
  /**
   * The promotion codes applied on the cart.
   * These promotion codes will replace previously applied codes.
   */
  promo_codes?: string[]
  /**
   * Force refresh the cart items
   */
  force_refresh?: boolean

  /**
   * The items to refresh.
   */
  items?: any[]

  /**
   * The shipping methods to refresh.
   */
  shipping_methods?: any[]

  /**
   * Whether to force re-calculating tax amounts, which
   * may include sending requests to a third-part tax provider, depending
   * on the configurations of the cart's tax region.
   */
  force_tax_calculation?: boolean
}

export const refreshCartItemsWorkflowId = "refresh-cart-items"
/**
 * This workflow refreshes a cart to ensure its prices, promotion codes, taxes, and other details are applied correctly. It's useful
 * after making a chnge to a cart, such as after adding an item to the cart or adding a promotion code.
 *
 * This workflow is used by other cart-related workflows, such as the {@link addToCartWorkflow} after an item
 * is added to the cart.
 *
 * You can use this workflow within your own customizations or custom workflows, allowing you to refresh the cart after making updates to it in your
 * custom flows.
 *
 * @example
 * const { result } = await refreshCartItemsWorkflow(container)
 * .run({
 *   input: {
 *     cart_id: "cart_123",
 *   }
 * })
 *
 * @summary
 *
 * Refresh a cart's details after an update.
 *
 * @property hooks.setPricingContext - This hook is executed before the cart is refreshed. You can consume this hook to return any custom context useful for the prices retrieval of the variants in the cart.
 *
 * For example, assuming you have the following custom pricing rule:
 *
 * ```json
 * {
 *   "attribute": "location_id",
 *   "operator": "eq",
 *   "value": "sloc_123",
 * }
 * ```
 *
 * You can consume the `setPricingContext` hook to add the `location_id` context to the prices calculation:
 *
 * ```ts
 * import { refreshCartItemsWorkflow } from "@medusajs/medusa/core-flows";
 * import { StepResponse } from "@medusajs/workflows-sdk";
 *
 * refreshCartItemsWorkflow.hooks.setPricingContext((
 *   { cart, items, additional_data }, { container }
 * ) => {
 *   return new StepResponse({
 *     location_id: "sloc_123", // Special price for in-store purchases
 *   });
 * });
 * ```
 *
 * The variants' prices will now be retrieved using the context you return.
 *
 * :::note
 *
 * Learn more about prices calculation context in the [Prices Calculation](https://docs.medusajs.com/resources/commerce-modules/pricing/price-calculation) documentation.
 *
 * :::
 *
 */
export const refreshCartItemsWorkflow = createWorkflow(
  {
    name: refreshCartItemsWorkflowId,
    idempotent: false,
  },
  (input: WorkflowData<RefreshCartItemsWorkflowInput & AdditionalData>) => {
    acquireLockStep({
      key: input.cart_id,
      timeout: 2,
      ttl: 10,
    })

    const setPricingContext = createHook(
      "setPricingContext",
      {
        cart_id: input.cart_id,
        items: input.items,
        additional_data: input.additional_data,
      },
      {
        resultValidator: pricingContextResult,
      }
    )
    const setPricingContextResult = setPricingContext.getResult()

    when("force-refresh-calculate-prices", { input }, ({ input }) => {
      return !!input.force_refresh
    }).then(() => {
      const { data: cart } = useQueryGraphStep({
        entity: "cart",
        fields: cartFieldsForRefreshSteps,
        filters: { id: input.cart_id },
        pagination: {
          take: 1,
        },
        options: {
          isList: false,
        },
      })

      const variantIds = transform({ cart }, (data: { cart: CartDTO }) => {
        return (data.cart.items ?? []).map((i) => i.variant_id).filter(Boolean)
      })

      const cartPricingContext = transform(
        { cart, setPricingContextResult },
        (data): { variantId: string; context: Record<string, unknown> }[] => {
          const cart = data.cart
          const baseContext = {
            ...filterObjectByKeys(cart, cartFieldsForPricingContext),
            ...(data.setPricingContextResult
              ? data.setPricingContextResult
              : {}),
            currency_code: cart.currency_code,
            region_id: cart.region_id,
            region: cart.region,
            customer_id: cart.customer_id,
            customer: cart.customer,
          }

          return cart.items
            .filter((i) => i.variant_id)
            .map((item) => {
              return {
                variantId: item.variant_id,
                context: {
                  ...baseContext,
                  quantity: item.quantity,
                },
              }
            })
        }
      )

      const { data: variantsData } = useQueryGraphStep({
        entity: "variants",
        fields: productVariantsFields,
        filters: {
          id: variantIds,
        },
      }).config({ name: "fetch-variants" })

      const calculatedPriceSets = getVariantPriceSetsStep({
        data: cartPricingContext,
      })

      const variants = transform(
        { variantsData, calculatedPriceSets },
        ({ variantsData, calculatedPriceSets }) => {
          return variantsData.map((variant) => {
            variant.calculated_price = calculatedPriceSets[variant.id]
            return variant
          })
        }
      )

      validateVariantPricesStep({ variants })

      const lineItems = transform({ cart, variants }, ({ cart, variants }) => {
        const items = cart.items.map((item) => {
          const variant = (variants ?? []).find(
            (v) => v.id === item.variant_id
          )!

          const input: PrepareLineItemDataInput = {
            item,
            variant: variant,
            cartId: cart.id,
            unitPrice: item.unit_price,
            isTaxInclusive: item.is_tax_inclusive,
          }

          if (variant && !item.is_custom_price) {
            input.unitPrice = variant.calculated_price?.calculated_amount
            input.isTaxInclusive =
              variant.calculated_price?.is_calculated_price_tax_inclusive
          }

          const preparedItem = prepareLineItemData(input)

          return {
            selector: { id: item.id },
            data: preparedItem,
          }
        })

        return items
      })

      updateLineItemsStep({
        id: cart.id,
        items: lineItems,
      })
    })

    const refetchedCart = useRemoteQueryStep({
      entry_point: "cart",
      fields: cartFieldsForRefreshSteps,
      variables: { id: input.cart_id },
      list: false,
    }).config({ name: "refetch–cart" })

    refreshCartShippingMethodsWorkflow.runAsStep({
      input: { cart: refetchedCart, additional_data: input.additional_data },
    })

    when("force-refresh-update-tax-lines", { input }, ({ input }) => {
      return !!input.force_refresh
    }).then(() => {
      updateTaxLinesWorkflow.runAsStep({
        input: { cart_id: input.cart_id },
      })
    })

    when("force-refresh-upsert-tax-lines", { input }, ({ input }) => {
      return (
        !input.force_refresh &&
        (!!input.items?.length || !!input.shipping_methods?.length)
      )
    }).then(() => {
      upsertTaxLinesWorkflow.runAsStep({
        input: transform(
          { refetchedCart, input },
          ({ refetchedCart, input }) => {
            return {
              cart: refetchedCart,
              items: input.items ?? [],
              shipping_methods: input.shipping_methods ?? [],
              force_tax_calculation: input.force_tax_calculation,
            }
          }
        ),
      })
    })

    const cartPromoCodes = transform(
      { refetchedCart, input },
      ({ refetchedCart, input }) => {
        if (isDefined(input.promo_codes)) {
          return input.promo_codes
        } else {
          return refetchedCart.promotions.map((p) => p?.code).filter(Boolean)
        }
      }
    )

    updateCartPromotionsWorkflow.runAsStep({
      input: {
        cart_id: input.cart_id,
        promo_codes: cartPromoCodes,
        action: PromotionActions.REPLACE,
      },
    })

    const beforeRefreshingPaymentCollection = createHook(
      "beforeRefreshingPaymentCollection",
      { input }
    )

    refreshPaymentCollectionForCartWorkflow.runAsStep({
      input: { cart: refetchedCart },
    })

    releaseLockStep({
      key: input.cart_id,
    })

    return new WorkflowResponse(refetchedCart, {
      hooks: [setPricingContext, beforeRefreshingPaymentCollection] as const,
    })
  }
)
