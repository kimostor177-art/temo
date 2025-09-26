import {
  BigNumberInput,
  CartDTO,
  CartLineItemDTO,
  CreateCartCreateLineItemDTO,
  CustomerDTO,
  OrderWorkflow,
  RegionDTO,
  UpdateLineItemDTO,
  UpdateLineItemWithSelectorDTO,
} from "@medusajs/framework/types"
import {
  filterObjectByKeys,
  isDefined,
  MedusaError,
  simpleHash,
} from "@medusajs/framework/utils"
import {
  createWorkflow,
  transform,
  WorkflowData,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { useQueryGraphStep } from "../../common"
import { getVariantPriceSetsStep } from "../steps"
import {
  cartFieldsForPricingContext,
  productVariantsFields,
} from "../utils/fields"
import {
  prepareLineItemData,
  PrepareLineItemDataInput,
} from "../utils/prepare-line-item-data"

interface GetVariantsAndItemsWithPricesWorkflowInput {
  cart: Partial<CartDTO> & {
    region?: Partial<RegionDTO>
    region_id?: string
    customer?: Partial<CustomerDTO>
    customer_id?: string
  }
  items?: Partial<
    | CreateCartCreateLineItemDTO
    | CartLineItemDTO
    | OrderWorkflow.OrderAddLineItemWorkflowInput["items"][number]
  >[]
  setPricingContextResult: object
  variants?: {
    id?: string[]
    fields?: string[]
  }
}

type GetVariantsAndItemsWithPricesWorkflowOutput = {
  // The variant can depend on the requested fields and therefore the caller will know better
  variants: (object & {
    calculated_price: {
      calculated_price: {
        price_list_type: string
      }
      is_calculated_price_tax_inclusive: boolean
      original_amount: BigNumberInput
      calculated_amount: BigNumberInput
    }
  })[]
  lineItems: UpdateLineItemWithSelectorDTO[]
}

export const getVariantsAndItemsWithPricesId =
  "get-variant-items-with-prices-workflow"
export const getVariantsAndItemsWithPrices = createWorkflow(
  getVariantsAndItemsWithPricesId,
  (
    input: WorkflowData<GetVariantsAndItemsWithPricesWorkflowInput>
  ): WorkflowResponse<GetVariantsAndItemsWithPricesWorkflowOutput> => {
    const variantIds = transform(
      { cart: input.cart, items: input.items, variantIds: input.variants?.id },
      (data): string[] => {
        if (data.variantIds) {
          return data.variantIds
        }

        return Array.from(
          new Set(
            (data.cart.items ?? data.items ?? []).map((i) => i.variant_id)
          )
        ).filter((v): v is string => !!v)
      }
    )

    const cartPricingContext = transform(
      {
        cart: input.cart,
        items: input.items,
        setPricingContextResult: input.setPricingContextResult,
      },
      (
        data
      ): {
        id: string
        variantId: string
        context: Record<string, unknown>
      }[] => {
        const cart = data.cart
        const baseContext = {
          ...filterObjectByKeys(cart, cartFieldsForPricingContext),
          ...(data.setPricingContextResult ? data.setPricingContextResult : {}),
          currency_code: cart.currency_code ?? cart.region?.currency_code,
          region_id: cart.region_id,
          region: cart.region,
          customer_id: cart.customer_id,
          customer: cart.customer,
        }

        return (data.items ?? cart.items ?? [])
          .filter((i) => i.variant_id)
          .map((item) => {
            const idLike =
              (item as CartLineItemDTO).id ?? simpleHash(JSON.stringify(item))
            return {
              id: idLike,
              variantId: item.variant_id!,
              context: {
                ...baseContext,
                quantity: item.quantity,
              },
            }
          })
      }
    )

    const variantQueryFields = transform(
      { variants: input.variants },
      (data) => {
        return data.variants?.fields ?? productVariantsFields
      }
    )

    const { data: variantsData } = useQueryGraphStep({
      entity: "variants",
      fields: variantQueryFields,
      filters: {
        id: variantIds,
      },
    }).config({ name: "fetch-variants" })

    const calculatedPriceSets = getVariantPriceSetsStep({
      data: cartPricingContext,
    })

    const variantsItemsWithPrices = transform(
      {
        cart: input.cart,
        items: input.items,
        variantsData,
        calculatedPriceSets,
      },
      ({
        cart,
        items: inputItems,
        variantsData,
        calculatedPriceSets,
      }): GetVariantsAndItemsWithPricesWorkflowOutput => {
        const priceNotFound: string[] = []

        const items = (inputItems ?? cart.items ?? []).map((item) => {
          const item_ = item as any
          const idLike =
            (item as CartLineItemDTO).id ?? simpleHash(JSON.stringify(item))
          let calculatedPriceSet = calculatedPriceSets[idLike]
          if (!calculatedPriceSet) {
            calculatedPriceSet = calculatedPriceSets[item_.variant_id!]
          }

          if (!calculatedPriceSet && item_.variant_id) {
            priceNotFound.push(item_.variant_id)
          }

          const variant = variantsData.find((v) => v.id === item.variant_id)

          if (variant) {
            variant.calculated_price = calculatedPriceSet
          }

          const isCustomPrice =
            item_.is_custom_price ?? isDefined(item?.unit_price)

          const input: PrepareLineItemDataInput = {
            item: item_,
            variant: variant,
            cartId: cart.id,
            unitPrice: item_.unit_price,
            isTaxInclusive:
              item_.is_tax_inclusive ??
              calculatedPriceSet?.is_calculated_price_tax_inclusive,
            isCustomPrice: isCustomPrice,
          }

          if (variant && !isCustomPrice) {
            input.unitPrice = calculatedPriceSet.calculated_amount
            input.isTaxInclusive =
              calculatedPriceSet.is_calculated_price_tax_inclusive
          }

          const preparedItem = prepareLineItemData(input)

          return {
            selector: { id: (item_ as CartLineItemDTO).id },
            data: preparedItem as Partial<UpdateLineItemDTO>,
          }
        })

        if (priceNotFound.length > 0) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `Variants with IDs ${priceNotFound.join(", ")} do not have a price`
          )
        }

        return { variants: variantsData, lineItems: items }
      }
    )

    return new WorkflowResponse(variantsItemsWithPrices)
  }
)
