import {
  CartCreditLineDTO,
  CartWorkflowDTO,
  LinkDefinition,
  PromotionDTO,
  UsageComputedActions,
} from "@medusajs/framework/types"
import {
  isDefined,
  Modules,
  OrderStatus,
  OrderWorkflowEvents,
} from "@medusajs/framework/utils"
import {
  createHook,
  createWorkflow,
  parallelize,
  transform,
  when,
  WorkflowData,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  createRemoteLinkStep,
  emitEventStep,
  useQueryGraphStep,
} from "../../common"
import { acquireLockStep } from "../../locking/steps/acquire-lock"
import { releaseLockStep } from "../../locking/steps/release-lock"
import { addOrderTransactionStep } from "../../order/steps/add-order-transaction"
import { createOrdersStep } from "../../order/steps/create-orders"
import { authorizePaymentSessionStep } from "../../payment/steps/authorize-payment-session"
import { registerUsageStep } from "../../promotion/steps/register-usage"
import {
  updateCartsStep,
  validateCartPaymentsStep,
  validateShippingStep,
} from "../steps"
import { compensatePaymentIfNeededStep } from "../steps/compensate-payment-if-needed"
import { reserveInventoryStep } from "../steps/reserve-inventory"
import { completeCartFields } from "../utils/fields"
import { prepareConfirmInventoryInput } from "../utils/prepare-confirm-inventory-input"
import {
  prepareAdjustmentsData,
  prepareLineItemData,
  PrepareLineItemDataInput,
  prepareTaxLinesData,
} from "../utils/prepare-line-item-data"
/**
 * The data to complete a cart and place an order.
 */
export type CompleteCartWorkflowInput = {
  /**
   * The ID of the cart to complete.
   */
  id: string
}

export type CompleteCartWorkflowOutput = {
  /**
   * The ID of the order that was created.
   */
  id: string
}

const THREE_DAYS = 60 * 60 * 24 * 3
const THIRTY_SECONDS = 30
const TWO_MINUTES = 60 * 2

export const completeCartWorkflowId = "complete-cart"
/**
 * This workflow completes a cart and places an order for the customer. It's executed by the
 * [Complete Cart Store API Route](https://docs.medusajs.com/api/store#carts_postcartsidcomplete).
 *
 * You can use this workflow within your own customizations or custom workflows, allowing you to wrap custom logic around completing a cart.
 * For example, in the [Subscriptions recipe](https://docs.medusajs.com/resources/recipes/subscriptions/examples/standard#create-workflow),
 * this workflow is used within another workflow that creates a subscription order.
 *
 * @example
 * const { result } = await completeCartWorkflow(container)
 * .run({
 *   input: {
 *     id: "cart_123"
 *   }
 * })
 *
 * @summary
 *
 * Complete a cart and place an order.
 *
 * @property hooks.validate - This hook is executed before all operations. You can consume this hook to perform any custom validation. If validation fails, you can throw an error to stop the workflow execution.
 */
export const completeCartWorkflow = createWorkflow(
  {
    name: completeCartWorkflowId,
    store: true,
    idempotent: false,
    retentionTime: THREE_DAYS,
  },
  (input: WorkflowData<CompleteCartWorkflowInput>) => {
    acquireLockStep({
      key: input.id,
      timeout: THIRTY_SECONDS,
      ttl: TWO_MINUTES,
    })

    const [orderCart, cartData] = parallelize(
      useQueryGraphStep({
        entity: "order_cart",
        fields: ["cart_id", "order_id"],
        filters: { cart_id: input.id },
        options: {
          isList: false,
        },
      }),
      useQueryGraphStep({
        entity: "cart",
        fields: completeCartFields,
        filters: { id: input.id },
        options: {
          isList: false,
        },
      }).config({
        name: "cart-query",
      })
    )

    const orderId = transform({ orderCart }, ({ orderCart }) => {
      return orderCart?.data?.order_id
    })

    // this needs to be before the validation step
    const paymentSessions = validateCartPaymentsStep({ cart: cartData.data })
    // purpose of this step is to run compensation if cart completion fails
    // and tries to refund the payment if captured
    compensatePaymentIfNeededStep({
      payment_session_id: paymentSessions[0].id,
    })

    const validate = createHook("validate", {
      input,
      cart: cartData.data,
    })

    // If order ID does not exist, we are completing the cart for the first time
    const order = when("create-order", { orderId }, ({ orderId }) => {
      return !orderId
    }).then(() => {
      const cartOptionIds = transform({ cart: cartData.data }, ({ cart }) => {
        return cart.shipping_methods?.map((sm) => sm.shipping_option_id)
      })

      const shippingOptionsData = useQueryGraphStep({
        entity: "shipping_option",
        fields: ["id", "shipping_profile_id"],
        filters: { id: cartOptionIds },
        options: {
          cache: {
            enable: true,
          },
        },
      }).config({
        name: "shipping-options-query",
      })

      validateShippingStep({
        cart: cartData.data,
        shippingOptions: shippingOptionsData.data,
      })

      const { variants, sales_channel_id } = transform(
        { cart: cartData.data },
        (data) => {
          const variantsMap: Record<string, any> = {}
          const allItems = data.cart?.items?.map((item) => {
            variantsMap[item.variant_id] = item.variant

            return {
              id: item.id,
              variant_id: item.variant_id,
              quantity: item.quantity,
            }
          })

          return {
            variants: Object.values(variantsMap),
            items: allItems,
            sales_channel_id: data.cart.sales_channel_id,
          }
        }
      )

      const cartToOrder = transform({ cart: cartData.data }, ({ cart }) => {
        const allItems = (cart.items ?? []).map((item) => {
          const input: PrepareLineItemDataInput = {
            item,
            variant: item.variant,
            cartId: cart.id,
            unitPrice: item.unit_price,
            isTaxInclusive: item.is_tax_inclusive,
            taxLines: item.tax_lines ?? [],
            adjustments: item.adjustments ?? [],
          }

          return prepareLineItemData(input)
        })

        const shippingMethods = (cart.shipping_methods ?? []).map((sm) => {
          return {
            name: sm.name,
            description: sm.description,
            amount: sm.raw_amount ?? sm.amount,
            is_tax_inclusive: sm.is_tax_inclusive,
            shipping_option_id: sm.shipping_option_id,
            data: sm.data,
            metadata: sm.metadata,
            tax_lines: prepareTaxLinesData(sm.tax_lines ?? []),
            adjustments: prepareAdjustmentsData(sm.adjustments ?? []),
          }
        })

        const creditLines = (cart.credit_lines ?? []).map(
          (creditLine: CartCreditLineDTO) => {
            return {
              amount: creditLine.amount,
              raw_amount: creditLine.raw_amount,
              reference: creditLine.reference,
              reference_id: creditLine.reference_id,
              metadata: creditLine.metadata,
            }
          }
        )

        const itemAdjustments = allItems
          .map((item) => item.adjustments ?? [])
          .flat(1)
        const shippingAdjustments = shippingMethods
          .map((sm) => sm.adjustments ?? [])
          .flat(1)

        const promoCodes = [...itemAdjustments, ...shippingAdjustments]
          .map((adjustment) => adjustment.code)
          .filter(Boolean)

        const shippingAddress = cart.shipping_address
          ? { ...cart.shipping_address }
          : null
        const billingAddress = cart.billing_address
          ? { ...cart.billing_address }
          : null

        if (shippingAddress) {
          delete shippingAddress.id
        }

        if (billingAddress) {
          delete billingAddress.id
        }

        return {
          region_id: cart.region?.id,
          customer_id: cart.customer?.id,
          sales_channel_id: cart.sales_channel_id,
          status: OrderStatus.PENDING,
          email: cart.email,
          currency_code: cart.currency_code,
          shipping_address: shippingAddress,
          billing_address: billingAddress,
          no_notification: false,
          items: allItems,
          shipping_methods: shippingMethods,
          metadata: cart.metadata,
          promo_codes: promoCodes,
          credit_lines: creditLines,
        }
      })

      const createdOrders = createOrdersStep([cartToOrder])

      const createdOrder = transform({ createdOrders }, ({ createdOrders }) => {
        return createdOrders[0]
      })

      const reservationItemsData = transform(
        { createdOrder },
        ({ createdOrder }) =>
          createdOrder.items!.map((i) => ({
            variant_id: i.variant_id,
            quantity: i.quantity,
            id: i.id,
          }))
      )

      const formatedInventoryItems = transform(
        {
          input: {
            sales_channel_id,
            variants,
            items: reservationItemsData,
          },
        },
        prepareConfirmInventoryInput
      )

      const updateCompletedAt = transform(
        { cart: cartData.data },
        ({ cart }) => {
          return {
            id: cart.id,
            completed_at: new Date(),
          }
        }
      )

      const promotionUsage = transform(
        { cart: cartData.data },
        ({ cart }: { cart: CartWorkflowDTO }) => {
          const promotionUsage: UsageComputedActions[] = []

          const itemAdjustments = (cart.items ?? [])
            .map((item) => item.adjustments ?? [])
            .flat(1)

          const shippingAdjustments = (cart.shipping_methods ?? [])
            .map((item) => item.adjustments ?? [])
            .flat(1)

          for (const adjustment of itemAdjustments) {
            promotionUsage.push({
              amount: adjustment.amount,
              code: adjustment.code!,
            })
          }

          for (const adjustment of shippingAdjustments) {
            promotionUsage.push({
              amount: adjustment.amount,
              code: adjustment.code!,
            })
          }

          return {
            computedActions: promotionUsage,
            registrationContext: {
              customer_id: cart.customer?.id || null,
              customer_email: cart.email || null,
            },
          }
        }
      )

      const linksToCreate = transform(
        { cart: cartData.data, createdOrder },
        ({ cart, createdOrder }) => {
          const links: LinkDefinition[] = [
            {
              [Modules.ORDER]: { order_id: createdOrder.id },
              [Modules.CART]: { cart_id: cart.id },
            },
          ]

          if (cart.promotions?.length) {
            cart.promotions.forEach((promotion: PromotionDTO) => {
              links.push({
                [Modules.ORDER]: { order_id: createdOrder.id },
                [Modules.PROMOTION]: { promotion_id: promotion.id },
              })
            })
          }

          if (isDefined(cart.payment_collection?.id)) {
            links.push({
              [Modules.ORDER]: { order_id: createdOrder.id },
              [Modules.PAYMENT]: {
                payment_collection_id: cart.payment_collection.id,
              },
            })
          }

          return links
        }
      )

      parallelize(
        createRemoteLinkStep(linksToCreate),
        updateCartsStep([updateCompletedAt]),
        reserveInventoryStep(formatedInventoryItems),
        registerUsageStep(promotionUsage),
        emitEventStep({
          eventName: OrderWorkflowEvents.PLACED,
          data: { id: createdOrder.id },
        })
      )

      /**
       * @ignore
       */
      createHook("beforePaymentAuthorization", {
        input,
      })

      // We authorize payment sessions at the very end of the workflow to minimize the risk of
      // canceling the payment in the compensation flow. The only operations that can trigger it
      // is creating the transactions, the workflow hook, and the linking.
      const payment = authorizePaymentSessionStep({
        // We choose the first payment session, as there will only be one active payment session
        // This might change in the future.
        id: paymentSessions![0].id,
      })

      const orderTransactions = transform(
        { payment, createdOrder },
        ({ payment, createdOrder }) => {
          const transactions =
            (payment &&
              payment?.captures?.map((capture) => {
                return {
                  order_id: createdOrder.id,
                  amount: capture.raw_amount ?? capture.amount,
                  currency_code: payment.currency_code,
                  reference: "capture",
                  reference_id: capture.id,
                }
              })) ??
            []

          return transactions
        }
      )

      addOrderTransactionStep(orderTransactions)

      /**
       * @ignore
       */
      createHook("orderCreated", {
        order_id: createdOrder.id,
        cart_id: cartData.data.id,
      })

      return createdOrder
    })

    releaseLockStep({
      key: input.id,
    })

    const result = transform({ order, orderId }, ({ order, orderId }) => {
      return { id: order?.id ?? orderId } as CompleteCartWorkflowOutput
    })

    return new WorkflowResponse(result, {
      hooks: [validate],
    })
  }
)
