import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  ContainerRegistrationKeys,
  Modules,
  OrderChangeStatus,
  ProductStatus,
  RuleOperator,
} from "@medusajs/utils"
import {
  adminHeaders,
  createAdminUser,
  generatePublishableKey,
  generateStoreHeaders,
} from "../../../helpers/create-admin-user"
import { medusaTshirtProduct } from "../../__fixtures__/product"

jest.setTimeout(300000)

medusaIntegrationTestRunner({
  testSuite: ({ dbConnection, getContainer, api }) => {
    let order
    let taxLine
    let shippingOption
    let shippingProfile
    let fulfillmentSet
    let inventoryItem
    let inventoryItemExtra
    let location
    let locationTwo
    let productExtra
    let container
    let region
    let salesChannel
    const shippingProviderId = "manual_test-provider"

    beforeEach(async () => {
      container = getContainer()
      await createAdminUser(dbConnection, adminHeaders, container)

      region = (
        await api.post(
          "/admin/regions",
          {
            name: "test-region",
            currency_code: "usd",
          },
          adminHeaders
        )
      ).data.region

      const customer = (
        await api.post(
          "/admin/customers",
          {
            first_name: "joe",
            email: "joe@admin.com",
          },
          adminHeaders
        )
      ).data.customer

      const taxRegion = (
        await api.post(
          "/admin/tax-regions",
          {
            provider_id: "tp_system",
            country_code: "US",
          },
          adminHeaders
        )
      ).data.tax_region

      taxLine = (
        await api.post(
          "/admin/tax-rates",
          {
            rate: 10,
            code: "standard",
            name: "Taxation is theft",
            is_default: true,
            tax_region_id: taxRegion.id,
          },
          adminHeaders
        )
      ).data.tax_rate

      salesChannel = (
        await api.post(
          "/admin/sales-channels",
          {
            name: "Test channel",
          },
          adminHeaders
        )
      ).data.sales_channel

      shippingProfile = (
        await api.post(
          `/admin/shipping-profiles`,
          {
            name: "Test",
            type: "default",
          },
          adminHeaders
        )
      ).data.shipping_profile

      const product = (
        await api.post(
          "/admin/products",
          {
            title: "Test product",
            status: ProductStatus.PUBLISHED,
            options: [{ title: "size", values: ["large", "small"] }],
            shipping_profile_id: shippingProfile.id,
            variants: [
              {
                title: "Test variant",
                sku: "test-variant",
                options: { size: "large" },
                prices: [
                  {
                    currency_code: "usd",
                    amount: 10,
                  },
                ],
              },
            ],
          },
          adminHeaders
        )
      ).data.product

      productExtra = (
        await api.post(
          "/admin/products",
          {
            title: "Extra product",
            status: ProductStatus.PUBLISHED,
            options: [{ title: "size", values: ["large", "small"] }],
            shipping_profile_id: shippingProfile.id,
            variants: [
              {
                title: "my variant",
                sku: "variant-sku",
                options: { size: "large" },
                prices: [
                  {
                    currency_code: "usd",
                    amount: 12,
                  },
                ],
              },
            ],
          },
          adminHeaders
        )
      ).data.product

      const orderModule = container.resolve(Modules.ORDER)

      order = await orderModule.createOrders({
        region_id: region.id,
        email: "foo@bar.com",
        items: [
          {
            title: "Custom Item",
            variant_id: product.variants[0].id,
            quantity: 2,
            unit_price: 25,
          },
        ],
        sales_channel_id: salesChannel.id,
        shipping_address: {
          first_name: "Test",
          last_name: "Test",
          address_1: "Test",
          city: "Test",
          country_code: "US",
          postal_code: "12345",
          phone: "12345",
        },
        billing_address: {
          first_name: "Test",
          last_name: "Test",
          address_1: "Test",
          city: "Test",
          country_code: "US",
          postal_code: "12345",
        },
        shipping_methods: [
          {
            name: "Test shipping method",
            amount: 10,
          },
        ],
        currency_code: "usd",
        customer_id: customer.id,
      })

      location = (
        await api.post(
          `/admin/stock-locations`,
          {
            name: "Test location",
          },
          adminHeaders
        )
      ).data.stock_location

      location = (
        await api.post(
          `/admin/stock-locations/${location.id}/fulfillment-sets?fields=*fulfillment_sets`,
          {
            name: "Test",
            type: "test-type",
          },
          adminHeaders
        )
      ).data.stock_location

      fulfillmentSet = (
        await api.post(
          `/admin/fulfillment-sets/${location.fulfillment_sets[0].id}/service-zones`,
          {
            name: "Test",
            geo_zones: [{ type: "country", country_code: "us" }],
          },
          adminHeaders
        )
      ).data.fulfillment_set

      inventoryItem = (
        await api.post(
          `/admin/inventory-items`,
          { sku: "inv-1234" },
          adminHeaders
        )
      ).data.inventory_item

      await api.post(
        `/admin/inventory-items/${inventoryItem.id}/location-levels`,
        {
          location_id: location.id,
          stocked_quantity: 2,
        },
        adminHeaders
      )

      inventoryItemExtra = (
        await api.get(`/admin/inventory-items?sku=variant-sku`, adminHeaders)
      ).data.inventory_items[0]

      await api.post(
        `/admin/inventory-items/${inventoryItemExtra.id}/location-levels`,
        {
          location_id: location.id,
          stocked_quantity: 4,
        },
        adminHeaders
      )

      const remoteLink = container.resolve(
        ContainerRegistrationKeys.REMOTE_LINK
      )

      await remoteLink.create([
        {
          [Modules.STOCK_LOCATION]: {
            stock_location_id: location.id,
          },
          [Modules.FULFILLMENT]: {
            fulfillment_provider_id: shippingProviderId,
          },
        },
        {
          [Modules.STOCK_LOCATION]: {
            stock_location_id: location.id,
          },
          [Modules.FULFILLMENT]: {
            fulfillment_set_id: fulfillmentSet.id,
          },
        },
        {
          [Modules.SALES_CHANNEL]: {
            sales_channel_id: salesChannel.id,
          },
          [Modules.STOCK_LOCATION]: {
            stock_location_id: location.id,
          },
        },
        {
          [Modules.PRODUCT]: {
            variant_id: product.variants[0].id,
          },
          [Modules.INVENTORY]: {
            inventory_item_id: inventoryItem.id,
          },
        },
        {
          [Modules.PRODUCT]: {
            variant_id: productExtra.variants[0].id,
          },
          [Modules.INVENTORY]: {
            inventory_item_id: inventoryItemExtra.id,
          },
        },
      ])

      const shippingOptionPayload = {
        name: "Shipping",
        service_zone_id: fulfillmentSet.service_zones[0].id,
        shipping_profile_id: shippingProfile.id,
        provider_id: shippingProviderId,
        price_type: "flat",
        type: {
          label: "Test type",
          description: "Test description",
          code: "test-code",
        },
        prices: [
          {
            currency_code: "usd",
            amount: 10,
          },
        ],
        rules: [
          {
            operator: RuleOperator.EQ,
            attribute: "is_return",
            value: "true",
          },
        ],
      }

      shippingOption = (
        await api.post(
          "/admin/shipping-options",
          shippingOptionPayload,
          adminHeaders
        )
      ).data.shipping_option
    })

    describe("Order Edits lifecycle", () => {
      it("Full flow test", async () => {
        let result = await api.post(
          "/admin/order-edits",
          {
            order_id: order.id,
            description: "Test",
          },
          adminHeaders
        )

        const orderId = result.data.order_change.order_id

        const item = order.items[0]

        result = (await api.get(`/admin/orders/${orderId}`, adminHeaders)).data
          .order

        expect(result.summary.current_order_total).toEqual(60)
        expect(result.summary.original_order_total).toEqual(60)

        // New Items ($12 each)
        result = (
          await api.post(
            `/admin/order-edits/${orderId}/items`,
            {
              items: [
                {
                  variant_id: productExtra.variants[0].id,
                  quantity: 2,
                },
              ],
            },
            adminHeaders
          )
        ).data.order_preview

        expect(result.summary.current_order_total).toEqual(86.4)
        expect(result.summary.original_order_total).toEqual(60)

        // Update item quantity and unit_price with the same amount as we have originally should not change totals
        result = (
          await api.post(
            `/admin/order-edits/${orderId}/items/item/${item.id}`,
            {
              quantity: 2,
              unit_price: 25,
            },
            adminHeaders
          )
        ).data.order_preview

        expect(result.summary.current_order_total).toEqual(86.4)
        expect(result.summary.original_order_total).toEqual(60)

        // Update item quantity, but keep the price as it was originally, should add + 25 to previous amount
        result = (
          await api.post(
            `/admin/order-edits/${orderId}/items/item/${item.id}`,
            {
              quantity: 3,
              unit_price: 25,
            },
            adminHeaders
          )
        ).data.order_preview

        expect(result.summary.current_order_total).toEqual(111.4)
        expect(result.summary.original_order_total).toEqual(60)

        // Update item quantity, with a new price
        // 30 * 3 = 90 (new item)
        // 12 * 2 = 24 (custom item)
        // 10 * 1 = 10 (shipping item)
        // total = 124
        result = (
          await api.post(
            `/admin/order-edits/${orderId}/items/item/${item.id}`,
            {
              quantity: 3,
              unit_price: 30,
            },
            adminHeaders
          )
        ).data.order_preview

        expect(result.summary.current_order_total).toEqual(126.4)
        expect(result.summary.original_order_total).toEqual(60)

        const updatedItem = result.items.find((i) => i.id === item.id)
        expect(updatedItem.actions).toEqual([
          expect.objectContaining({
            details: expect.objectContaining({
              quantity: 2,
              unit_price: 25,
              quantity_diff: 0,
            }),
          }),
          expect.objectContaining({
            details: expect.objectContaining({
              quantity: 3,
              unit_price: 25,
              quantity_diff: 1,
            }),
          }),
          expect.objectContaining({
            details: expect.objectContaining({
              quantity: 3,
              unit_price: 30,
              quantity_diff: 1,
            }),
          }),
        ])

        // Remove the item by setting the quantity to 0
        result = (
          await api.post(
            `/admin/order-edits/${orderId}/items/item/${item.id}`,
            {
              quantity: 0,
            },
            adminHeaders
          )
        ).data.order_preview

        expect(result.summary.current_order_total).toEqual(36.4)
        expect(result.summary.original_order_total).toEqual(60)
        expect(result.items.length).toEqual(2)

        result = (
          await api.post(
            `/admin/order-edits/${orderId}/request`,
            {},
            adminHeaders
          )
        ).data.order_preview

        expect(result.order_change.status).toEqual(OrderChangeStatus.REQUESTED)
        expect(result.summary.current_order_total).toEqual(36.4)
        expect(result.summary.original_order_total).toEqual(60)
        expect(result.items.length).toEqual(2)

        const newItem = result.items.find(
          (i) => i.variant_id === productExtra.variants[0].id
        )
        expect(newItem.tax_lines[0].tax_rate_id).toEqual(taxLine.id)
        expect(newItem.tax_lines[0].rate).toEqual(10)

        result = (
          await api.post(
            `/admin/order-edits/${orderId}/confirm`,
            {},
            adminHeaders
          )
        ).data.order_preview

        result = (await api.get(`/admin/orders/${orderId}`, adminHeaders)).data
          .order

        expect(result.total).toEqual(36.4)
        expect(result.items.length).toEqual(1)

        result = (
          await api.get(
            `/admin/orders/${orderId}/changes?change_type=edit`,
            adminHeaders
          )
        ).data.order_changes

        expect(result[0].actions).toHaveLength(5)
        expect(result[0].status).toEqual("confirmed")
        expect(result[0].confirmed_by).toEqual(expect.stringContaining("user_"))
      })
    })

    describe("Order Edit Inventory", () => {
      let product
      let inventoryItemLarge
      let inventoryItemMedium
      let inventoryItemSmall

      beforeEach(async () => {
        const container = getContainer()

        inventoryItemLarge = (
          await api.post(
            `/admin/inventory-items`,
            { sku: "shirt-large" },
            adminHeaders
          )
        ).data.inventory_item

        inventoryItemMedium = (
          await api.post(
            `/admin/inventory-items`,
            { sku: "shirt-medium" },
            adminHeaders
          )
        ).data.inventory_item

        inventoryItemSmall = (
          await api.post(
            `/admin/inventory-items`,
            { sku: "shirt-small" },
            adminHeaders
          )
        ).data.inventory_item

        location = (
          await api.post(
            `/admin/stock-locations`,
            {
              name: "Test location",
            },
            adminHeaders
          )
        ).data.stock_location

        locationTwo = (
          await api.post(
            `/admin/stock-locations`,
            {
              name: "Test location two",
            },
            adminHeaders
          )
        ).data.stock_location

        await api.post(
          `/admin/inventory-items/${inventoryItemLarge.id}/location-levels`,
          {
            location_id: location.id,
            stocked_quantity: 0,
          },
          adminHeaders
        )

        await api.post(
          `/admin/inventory-items/${inventoryItemLarge.id}/location-levels`,
          {
            location_id: locationTwo.id,
            stocked_quantity: 10,
          },
          adminHeaders
        )

        await api.post(
          `/admin/inventory-items/${inventoryItemMedium.id}/location-levels`,
          {
            location_id: location.id,
            stocked_quantity: 10,
          },
          adminHeaders
        )
        await api.post(
          `/admin/inventory-items/${inventoryItemSmall.id}/location-levels`,
          {
            location_id: location.id,
            stocked_quantity: 10,
          },
          adminHeaders
        )

        product = (
          await api.post(
            "/admin/products",
            {
              title: "Shirt",
              status: ProductStatus.PUBLISHED,
              options: [
                { title: "size", values: ["large", "medium", "small"] },
              ],
              variants: [
                {
                  title: "L shirt",
                  options: { size: "large" },
                  manage_inventory: true,
                  inventory_items: [
                    {
                      inventory_item_id: inventoryItemLarge.id,
                      required_quantity: 1,
                    },
                  ],
                  prices: [
                    {
                      currency_code: "usd",
                      amount: 10,
                    },
                  ],
                },
                {
                  title: "M shirt",
                  options: { size: "medium" },
                  manage_inventory: true,
                  inventory_items: [
                    {
                      inventory_item_id: inventoryItemMedium.id,
                      required_quantity: 1,
                    },
                  ],
                  prices: [
                    {
                      currency_code: "usd",
                      amount: 10,
                    },
                  ],
                },
                {
                  title: "S shirt",
                  options: { size: "small" },
                  manage_inventory: true,
                  inventory_items: [
                    {
                      inventory_item_id: inventoryItemSmall.id,
                      required_quantity: 1,
                    },
                  ],
                  prices: [
                    {
                      currency_code: "usd",
                      amount: 10,
                    },
                  ],
                },
              ],
            },
            adminHeaders
          )
        ).data.product

        const region = (
          await api.post(
            "/admin/regions",
            {
              name: "test-region",
              currency_code: "usd",
            },
            adminHeaders
          )
        ).data.region

        const customer = (
          await api.post(
            "/admin/customers",
            {
              first_name: "joe2",
              email: "joe2@admin.com",
            },
            adminHeaders
          )
        ).data.customer

        const taxRegion = (
          await api.post(
            "/admin/tax-regions",
            {
              provider_id: "tp_system",
              country_code: "UK",
            },
            adminHeaders
          )
        ).data.tax_region

        taxLine = (
          await api.post(
            "/admin/tax-rates",
            {
              rate: 10,
              code: "standard",
              name: "Taxation is theft",
              is_default: true,
              tax_region_id: taxRegion.id,
            },
            adminHeaders
          )
        ).data.tax_rate

        const salesChannel = (
          await api.post(
            "/admin/sales-channels",
            {
              name: "Test channel",
            },
            adminHeaders
          )
        ).data.sales_channel

        const orderModule = container.resolve(Modules.ORDER)

        order = await orderModule.createOrders({
          region_id: region.id,
          email: "foo@bar.com",
          items: [
            {
              title: "Medusa T-shirt",
              subtitle: "L shirt",
              variant_id: product.variants.find((v) => v.title === "L shirt")
                .id,
              quantity: 2,
              unit_price: 25,
            },
            {
              title: "Medusa T-shirt",
              subtitle: "M shirt",
              variant_id: product.variants.find((v) => v.title === "M shirt")
                .id,
              quantity: 2,
              unit_price: 25,
            },
          ],
          sales_channel_id: salesChannel.id,
          shipping_address: {
            first_name: "Test",
            last_name: "Test",
            address_1: "Test",
            city: "Test",
            country_code: "US",
            postal_code: "12345",
            phone: "12345",
          },
          billing_address: {
            first_name: "Test",
            last_name: "Test",
            address_1: "Test",
            city: "Test",
            country_code: "US",
            postal_code: "12345",
          },
          shipping_methods: [
            {
              name: "Test shipping method",
              amount: 10,
            },
          ],
          currency_code: "usd",
          customer_id: customer.id,
        })

        const remoteLink = container.resolve(
          ContainerRegistrationKeys.REMOTE_LINK
        )

        await remoteLink.create([
          {
            [Modules.SALES_CHANNEL]: {
              sales_channel_id: salesChannel.id,
            },
            [Modules.STOCK_LOCATION]: {
              stock_location_id: location.id,
            },
          },
          {
            [Modules.SALES_CHANNEL]: {
              sales_channel_id: salesChannel.id,
            },
            [Modules.STOCK_LOCATION]: {
              stock_location_id: locationTwo.id,
            },
          },
        ])
      })

      it("should manage reservations on order edit", async () => {
        let edit = (
          await api.post(
            `/admin/order-edits`,
            { order_id: order.id },
            adminHeaders
          )
        ).data.order_change

        // Add item
        await api.post(
          `/admin/order-edits/${order.id}/items`,
          {
            items: [
              {
                variant_id: product.variants.find((v) => v.title === "S shirt")
                  .id,
                quantity: 1,
              },
            ],
          },
          adminHeaders
        )

        // Remove item
        await api.post(
          `/admin/order-edits/${order.id}/items/item/${
            order.items.find((i) => i.subtitle === "M shirt").id
          }`,
          { quantity: 0 },
          adminHeaders
        )

        // Update item
        await api.post(
          `/admin/order-edits/${order.id}/items/item/${
            order.items.find((i) => i.subtitle === "L shirt").id
          }`,
          { quantity: 2 },
          adminHeaders
        )

        edit = (
          await api.post(
            `/admin/order-edits/${order.id}/request`,
            {},
            adminHeaders
          )
        ).data.order_change

        edit = (
          await api.post(
            `/admin/order-edits/${order.id}/confirm`,
            {},
            adminHeaders
          )
        ).data.order_change

        order = (await api.get(`/admin/orders/${order.id}`, adminHeaders)).data
          .order

        expect(order.items.length).toBe(2)
        expect(order.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              subtitle: "L shirt",
              quantity: 2,
            }),
            expect.objectContaining({
              subtitle: "S shirt",
              quantity: 1,
            }),
          ])
        )
        let reservations = (await api.get(`/admin/reservations`, adminHeaders))
          .data.reservations

        expect(reservations.length).toBe(2)
        expect(reservations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              inventory_item_id: inventoryItemLarge.id,
              quantity: 2,
            }),
            expect.objectContaining({
              inventory_item_id: inventoryItemSmall.id,
              quantity: 1,
            }),
          ])
        )
      })

      it("should manage inventory across locations in order edit", async () => {
        let edit = (
          await api.post(
            `/admin/order-edits`,
            { order_id: order.id },
            adminHeaders
          )
        ).data.order_change

        // Add item
        await api.post(
          `/admin/order-edits/${order.id}/items`,
          {
            items: [
              {
                variant_id: product.variants.find((v) => v.title === "L shirt")
                  .id,
                quantity: 1,
              },
            ],
          },
          adminHeaders
        )

        edit = (
          await api.post(
            `/admin/order-edits/${order.id}/request`,
            {},
            adminHeaders
          )
        ).data.order_change

        edit = (
          await api.post(
            `/admin/order-edits/${order.id}/confirm`,
            {},
            adminHeaders
          )
        ).data.order_change

        order = (await api.get(`/admin/orders/${order.id}`, adminHeaders)).data
          .order

        expect(order.items.length).toBe(3)
        expect(order.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              subtitle: "L shirt",
              quantity: 2,
            }),
          ])
        )
      })
    })

    describe("Order Edit Shipping Methods", () => {
      it("should add a shipping method through an order edit", async () => {
        await api.post(
          "/admin/order-edits",
          { order_id: order.id, description: "Test" },
          adminHeaders
        )

        const orderId = order.id

        const shippingMethodResponse = await api.post(
          `/admin/order-edits/${orderId}/shipping-method`,
          { shipping_option_id: shippingOption.id, custom_amount: 5 },
          adminHeaders
        )

        expect(
          shippingMethodResponse.data.order_preview.shipping_methods.length
        ).toEqual(2)
        expect(
          shippingMethodResponse.data.order_preview.shipping_methods
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              amount: 10,
            }),
            expect.objectContaining({
              amount: 5,
            }),
          ])
        )

        const requestResult = await api.post(
          `/admin/order-edits/${orderId}/request`,
          {},
          adminHeaders
        )

        expect(requestResult.data.order_preview.order_change.status).toEqual(
          OrderChangeStatus.REQUESTED
        )

        await api.post(
          `/admin/order-edits/${orderId}/confirm`,
          {},
          adminHeaders
        )

        const orderResult = await api.get(
          `/admin/orders/${orderId}`,
          adminHeaders
        )

        expect(orderResult.data.order.shipping_methods.length).toEqual(2)
        expect(orderResult.data.order.shipping_methods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ amount: 10 }),
            expect.objectContaining({ amount: 5 }),
          ])
        )

        const orderChangesResult = await api.get(
          `/admin/orders/${orderId}/changes?change_type=edit`,
          adminHeaders
        )

        expect(orderChangesResult.data.order_changes.length).toEqual(1)
        expect(orderChangesResult.data.order_changes[0].status).toEqual(
          OrderChangeStatus.CONFIRMED
        )
      })
    })

    describe("Order Edit Payment Collection", () => {
      let appContainer
      let storeHeaders
      let region, product, salesChannel

      const shippingAddressData = {
        address_1: "test address 1",
        address_2: "test address 2",
        city: "SF",
        country_code: "US",
        province: "CA",
        postal_code: "94016",
      }

      beforeAll(async () => {
        appContainer = getContainer()
      })

      beforeEach(async () => {
        const publishableKey = await generatePublishableKey(appContainer)
        storeHeaders = generateStoreHeaders({ publishableKey })

        region = (
          await api.post(
            "/admin/regions",
            { name: "US", currency_code: "usd", countries: ["us"] },
            adminHeaders
          )
        ).data.region

        product = (
          await api.post(
            "/admin/products",
            { ...medusaTshirtProduct },
            adminHeaders
          )
        ).data.product

        salesChannel = (
          await api.post(
            "/admin/sales-channels",
            { name: "Webshop", description: "channel" },
            adminHeaders
          )
        ).data.sales_channel
      })

      it("should add a create a new payment collection if the order has authorized payment collection", async () => {
        const cart = (
          await api.post(
            `/store/carts`,
            {
              currency_code: "usd",
              sales_channel_id: salesChannel.id,
              region_id: region.id,
              shipping_address: shippingAddressData,
              items: [{ variant_id: product.variants[0].id, quantity: 1 }],
            },
            storeHeaders
          )
        ).data.cart

        const paymentCollection = (
          await api.post(
            `/store/payment-collections`,
            { cart_id: cart.id },
            storeHeaders
          )
        ).data.payment_collection

        await api.post(
          `/store/payment-collections/${paymentCollection.id}/payment-sessions`,
          { provider_id: "pp_system_default" },
          storeHeaders
        )

        const order = (
          await api.post(
            `/store/carts/${cart.id}/complete`,
            { cart_id: cart.id },
            storeHeaders
          )
        ).data.order

        await api.post(
          `/admin/order-edits`,
          { order_id: order.id, description: "Test" },
          adminHeaders
        )

        await api.post(
          `/admin/order-edits/${order.id}/items`,
          {
            items: [
              {
                variant_id: product.variants[0].id,
                quantity: 1,
              },
            ],
          },
          adminHeaders
        )

        await api.post(
          `/admin/order-edits/${order.id}/confirm`,
          {},
          adminHeaders
        )

        const orderResult = (
          await api.get(`/admin/orders/${order.id}`, adminHeaders)
        ).data.order

        expect(orderResult.payment_collections).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: paymentCollection.id,
              status: "canceled",
            }),
            expect.objectContaining({
              id: expect.any(String),
              status: "not_paid",
              amount: orderResult.total,
            }),
          ])
        )
      })
    })
  },
})
