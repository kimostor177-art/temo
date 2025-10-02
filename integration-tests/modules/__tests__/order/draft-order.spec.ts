import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  IInventoryServiceNext,
  IPricingModuleService,
  IProductModuleService,
  IRegionModuleService,
  ISalesChannelModuleService,
  IStockLocationServiceNext,
  ITaxModuleService,
} from "@medusajs/types"
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
  PromotionStatus,
  PromotionType,
} from "@medusajs/utils"
import {
  adminHeaders,
  createAdminUser,
} from "../../../helpers/create-admin-user"
import { setupTaxStructure } from "../fixtures"

jest.setTimeout(100000)

const env = {}

medusaIntegrationTestRunner({
  env,
  testSuite: ({ dbConnection, getContainer, api }) => {
    let appContainer
    let regionModuleService: IRegionModuleService
    let scModuleService: ISalesChannelModuleService
    let productModule: IProductModuleService
    let pricingModule: IPricingModuleService
    let inventoryModule: IInventoryServiceNext
    let stockLocationModule: IStockLocationServiceNext
    let taxModule: ITaxModuleService
    let remoteLink

    beforeAll(async () => {
      appContainer = getContainer()
      regionModuleService = appContainer.resolve(Modules.REGION)
      scModuleService = appContainer.resolve(Modules.SALES_CHANNEL)
      productModule = appContainer.resolve(Modules.PRODUCT)
      pricingModule = appContainer.resolve(Modules.PRICING)
      inventoryModule = appContainer.resolve(Modules.INVENTORY)
      stockLocationModule = appContainer.resolve(Modules.STOCK_LOCATION)
      taxModule = appContainer.resolve(Modules.TAX)
      remoteLink = appContainer.resolve(ContainerRegistrationKeys.REMOTE_LINK)
    })

    beforeEach(async () => {
      await createAdminUser(dbConnection, adminHeaders, appContainer)
    })

    describe("Draft Orders - Admin", () => {
      it("should create a draft order", async () => {
        const region = await regionModuleService.createRegions({
          name: "US",
          currency_code: "usd",
        })

        const salesChannel = await scModuleService.createSalesChannels({
          name: "Webshop",
        })

        const location = await stockLocationModule.createStockLocations({
          name: "Warehouse",
        })

        const [product, product_2] = await productModule.createProducts([
          {
            title: "Test product",
            status: ProductStatus.PUBLISHED,
            variants: [
              {
                title: "Test variant",
              },
            ],
          },
          {
            title: "Another product",
            status: ProductStatus.PUBLISHED,
            variants: [
              {
                title: "Variant variable",
                manage_inventory: false,
              },
            ],
          },
        ])

        const inventoryItem = await inventoryModule.createInventoryItems({
          sku: "inv-1234",
        })

        await inventoryModule.createInventoryLevels([
          {
            inventory_item_id: inventoryItem.id,
            location_id: location.id,
            stocked_quantity: 2,
            reserved_quantity: 0,
          },
        ])

        const [priceSet, priceSet_2] = await pricingModule.createPriceSets([
          {
            prices: [
              {
                amount: 3000,
                currency_code: "usd",
              },
            ],
          },
          {
            prices: [
              {
                amount: 1000,
                currency_code: "usd",
              },
            ],
          },
        ])

        await api.post(
          "/admin/price-preferences",
          {
            attribute: "currency_code",
            value: "usd",
            is_tax_inclusive: true,
          },
          adminHeaders
        )

        await remoteLink.create([
          {
            [Modules.PRODUCT]: {
              variant_id: product.variants[0].id,
            },
            [Modules.PRICING]: {
              price_set_id: priceSet.id,
            },
          },
          {
            [Modules.PRODUCT]: {
              variant_id: product_2.variants[0].id,
            },
            [Modules.PRICING]: {
              price_set_id: priceSet_2.id,
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
              variant_id: product_2.variants[0].id,
            },
            [Modules.INVENTORY]: {
              inventory_item_id: inventoryItem.id,
            },
          },
        ])

        await setupTaxStructure(taxModule)

        const payload = {
          email: "oli@test.dk",
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          currency_code: "usd",
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
          items: [
            {
              variant_id: product.variants[0].id,
              quantity: 2,
            },
            {
              variant_id: product_2.variants[0].id,
              unit_price: 200,
              quantity: 1,
              metadata: {
                note: "reduced price",
              },
            },
            {
              title: "Custom Item",
              variant_sku: "sku123",
              variant_barcode: "barcode123",
              unit_price: 2200,
              quantity: 1,
            },
          ],
          shipping_methods: [
            {
              name: "test-method",
              shipping_option_id: "test-option",
              amount: 100,
            },
          ],
        }

        const response = await api.post(
          "/admin/draft-orders",
          payload,
          adminHeaders
        )

        expect(response.data).toEqual(
          expect.objectContaining({
            draft_order: expect.objectContaining({
              status: "draft",
              version: 1,
              summary: expect.objectContaining({
                // TODO: add summary fields
              }),
              items: expect.arrayContaining([
                expect.objectContaining({
                  title: "Test product",
                  subtitle: "Test variant",
                  product_title: "Test product",
                  product_description: null,
                  product_subtitle: null,
                  product_type: null,
                  product_type_id: null,
                  product_collection: null,
                  product_handle: "test-product",
                  variant_sku: null,
                  variant_barcode: null,
                  variant_title: "Test variant",
                  variant_option_values: null,
                  requires_shipping: true,
                  is_discountable: true,
                  is_tax_inclusive: true,
                  is_custom_price: false,
                  raw_compare_at_unit_price: null,
                  raw_unit_price: expect.objectContaining({
                    value: "3000",
                  }),
                  metadata: {},
                  tax_lines: [
                    expect.objectContaining({
                      code: "US_DEF",
                      provider_id: "system",
                      rate: 2,
                    }),
                  ],
                  adjustments: [],
                  unit_price: 3000,
                  quantity: 2,
                  raw_quantity: expect.objectContaining({
                    value: "2",
                  }),
                  detail: expect.objectContaining({
                    raw_quantity: expect.objectContaining({
                      value: "2",
                    }),
                    raw_fulfilled_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    raw_shipped_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    raw_return_requested_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    raw_return_received_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    raw_return_dismissed_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    raw_written_off_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    quantity: 2,
                    fulfilled_quantity: 0,
                    shipped_quantity: 0,
                    return_requested_quantity: 0,
                    return_received_quantity: 0,
                    return_dismissed_quantity: 0,
                    written_off_quantity: 0,
                  }),
                }),
                expect.objectContaining({
                  title: "Another product",
                  subtitle: "Variant variable",
                  raw_unit_price: expect.objectContaining({
                    value: "200",
                  }),
                  metadata: {
                    note: "reduced price",
                  },
                  unit_price: 200,
                  is_tax_inclusive: true,
                  quantity: 1,
                  raw_quantity: expect.objectContaining({
                    value: "1",
                  }),
                }),
                expect.objectContaining({
                  title: "Custom Item",
                  variant_sku: "sku123",
                  variant_barcode: "barcode123",
                  variant_title: null,
                  is_custom_price: true,
                  raw_unit_price: expect.objectContaining({
                    value: "2200",
                  }),
                  unit_price: 2200,
                  quantity: 1,
                  raw_quantity: expect.objectContaining({
                    value: "1",
                  }),
                }),
              ]),
              shipping_address: expect.objectContaining({
                last_name: "Test",
                address_1: "Test",
                city: "Test",
                country_code: "US",
                postal_code: "12345",
                phone: "12345",
              }),
              billing_address: expect.objectContaining({
                first_name: "Test",
                last_name: "Test",
                address_1: "Test",
                city: "Test",
                country_code: "US",
                postal_code: "12345",
              }),
              shipping_methods: [
                expect.objectContaining({
                  name: "test-method",
                  raw_amount: expect.objectContaining({
                    value: "100",
                  }),
                  is_tax_inclusive: false,
                  shipping_option_id: "test-option",
                  data: null,
                  tax_lines: [
                    expect.objectContaining({
                      code: "US_DEF",
                      provider_id: "system",
                      rate: 2,
                    }),
                  ],
                  adjustments: [],
                  amount: 100,
                }),
              ],
            }),
          })
        )

        expect(response.status).toEqual(200)
      })

      it("should create a draft order applying the correct promotion on the items", async () => {
        const region = await regionModuleService.createRegions({
          name: "US",
          currency_code: "usd",
        })

        const salesChannel = await scModuleService.createSalesChannels({
          name: "Webshop",
        })

        const location = await stockLocationModule.createStockLocations({
          name: "Warehouse",
        })

        const [product, product_2] = await productModule.createProducts([
          {
            title: "Test product",
            status: ProductStatus.PUBLISHED,
            variants: [
              {
                title: "Test variant",
              },
            ],
          },
          {
            title: "Another product",
            status: ProductStatus.PUBLISHED,
            variants: [
              {
                title: "Variant variable",
                manage_inventory: false,
              },
            ],
          },
        ])

        const inventoryItem = await inventoryModule.createInventoryItems({
          sku: "inv-1234",
        })

        await inventoryModule.createInventoryLevels([
          {
            inventory_item_id: inventoryItem.id,
            location_id: location.id,
            stocked_quantity: 2,
            reserved_quantity: 0,
          },
        ])

        const [priceSet, priceSet_2] = await pricingModule.createPriceSets([
          {
            prices: [
              {
                amount: 3000,
                currency_code: "usd",
              },
            ],
          },
          {
            prices: [
              {
                amount: 1000,
                currency_code: "usd",
              },
            ],
          },
        ])

        /**
         * Create a promotion to test with
         */
        const promotion = (
          await api.post(
            `/admin/promotions`,
            {
              code: "testytest",
              type: PromotionType.STANDARD,
              status: PromotionStatus.ACTIVE,
              application_method: {
                target_type: "items",
                type: "fixed",
                allocation: "each",
                currency_code: "usd",
                value: 100,
                max_quantity: 100,
                target_rules: [
                  {
                    attribute: "items.variant_id",
                    operator: "in",
                    values: [product.variants[0].id, product_2.variants[0].id],
                  },
                ],
              },
            },
            adminHeaders
          )
        ).data.promotion

        await api.post(
          "/admin/price-preferences",
          {
            attribute: "currency_code",
            value: "usd",
            is_tax_inclusive: true,
          },
          adminHeaders
        )

        await remoteLink.create([
          {
            [Modules.PRODUCT]: {
              variant_id: product.variants[0].id,
            },
            [Modules.PRICING]: {
              price_set_id: priceSet.id,
            },
          },
          {
            [Modules.PRODUCT]: {
              variant_id: product_2.variants[0].id,
            },
            [Modules.PRICING]: {
              price_set_id: priceSet_2.id,
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
              variant_id: product_2.variants[0].id,
            },
            [Modules.INVENTORY]: {
              inventory_item_id: inventoryItem.id,
            },
          },
        ])

        await setupTaxStructure(taxModule)

        const payload = {
          email: "oli@test.dk",
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          currency_code: "usd",
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
          promo_codes: ["testytest"],
          items: [
            {
              variant_id: product.variants[0].id,
              is_discountable: true,
              quantity: 2,
            },
            {
              variant_id: product_2.variants[0].id,
              is_discountable: true,
              unit_price: 200,
              quantity: 1,
              metadata: {
                note: "reduced price",
              },
            },
            {
              title: "Custom Item",
              variant_sku: "sku123",
              variant_barcode: "barcode123",
              is_discountable: true,
              unit_price: 2200,
              quantity: 1,
            },
          ],
          shipping_methods: [
            {
              name: "test-method",
              shipping_option_id: "test-option",
              amount: 100,
            },
          ],
        }

        const response = await api.post(
          "/admin/draft-orders",
          payload,
          adminHeaders
        )

        expect(response.data).toEqual(
          expect.objectContaining({
            draft_order: expect.objectContaining({
              status: "draft",
              version: 1,
              summary: expect.objectContaining({
                // TODO: add summary fields
              }),
              items: expect.arrayContaining([
                expect.objectContaining({
                  title: "Test product",
                  subtitle: "Test variant",
                  product_title: "Test product",
                  product_description: null,
                  product_subtitle: null,
                  product_type: null,
                  product_type_id: null,
                  product_collection: null,
                  product_handle: "test-product",
                  variant_sku: null,
                  variant_barcode: null,
                  variant_title: "Test variant",
                  variant_option_values: null,
                  requires_shipping: true,
                  is_discountable: true,
                  is_tax_inclusive: true,
                  is_custom_price: false,
                  raw_compare_at_unit_price: null,
                  raw_unit_price: expect.objectContaining({
                    value: "3000",
                  }),
                  metadata: {},
                  tax_lines: [
                    expect.objectContaining({
                      code: "US_DEF",
                      provider_id: "system",
                      rate: 2,
                    }),
                  ],
                  adjustments: [
                    expect.objectContaining({
                      amount: 200,
                      code: "testytest",
                      is_tax_inclusive: false,
                      promotion_id: promotion.id,
                      provider_id: null,
                    }),
                  ],
                  unit_price: 3000,
                  quantity: 2,
                  raw_quantity: expect.objectContaining({
                    value: "2",
                  }),
                  detail: expect.objectContaining({
                    raw_quantity: expect.objectContaining({
                      value: "2",
                    }),
                    raw_fulfilled_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    raw_shipped_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    raw_return_requested_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    raw_return_received_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    raw_return_dismissed_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    raw_written_off_quantity: expect.objectContaining({
                      value: "0",
                    }),
                    quantity: 2,
                    fulfilled_quantity: 0,
                    shipped_quantity: 0,
                    return_requested_quantity: 0,
                    return_received_quantity: 0,
                    return_dismissed_quantity: 0,
                    written_off_quantity: 0,
                  }),
                }),
                expect.objectContaining({
                  title: "Another product",
                  subtitle: "Variant variable",
                  raw_unit_price: expect.objectContaining({
                    value: "200",
                  }),
                  metadata: {
                    note: "reduced price",
                  },
                  unit_price: 200,
                  is_tax_inclusive: true,
                  quantity: 1,
                  raw_quantity: expect.objectContaining({
                    value: "1",
                  }),
                  adjustments: [
                    expect.objectContaining({
                      amount: 100,
                      code: "testytest",
                      is_tax_inclusive: false,
                      promotion_id: promotion.id,
                      provider_id: null,
                    }),
                  ],
                }),
                expect.objectContaining({
                  title: "Custom Item",
                  variant_sku: "sku123",
                  variant_barcode: "barcode123",
                  variant_title: null,
                  is_custom_price: true,
                  raw_unit_price: expect.objectContaining({
                    value: "2200",
                  }),
                  unit_price: 2200,
                  quantity: 1,
                  raw_quantity: expect.objectContaining({
                    value: "1",
                  }),
                }),
              ]),
              shipping_address: expect.objectContaining({
                last_name: "Test",
                address_1: "Test",
                city: "Test",
                country_code: "US",
                postal_code: "12345",
                phone: "12345",
              }),
              billing_address: expect.objectContaining({
                first_name: "Test",
                last_name: "Test",
                address_1: "Test",
                city: "Test",
                country_code: "US",
                postal_code: "12345",
              }),
              shipping_methods: [
                expect.objectContaining({
                  name: "test-method",
                  raw_amount: expect.objectContaining({
                    value: "100",
                  }),
                  is_tax_inclusive: false,
                  shipping_option_id: "test-option",
                  data: null,
                  tax_lines: [
                    expect.objectContaining({
                      code: "US_DEF",
                      provider_id: "system",
                      rate: 2,
                    }),
                  ],
                  adjustments: [],
                  amount: 100,
                }),
              ],
            }),
          })
        )

        expect(response.status).toEqual(200)
      })

      it("should create a draft order and apply tax by product type", async () => {
        const productType = await productModule.createProductTypes({
          value: "test_product_type",
        })

        const region = await regionModuleService.createRegions({
          name: "US",
          currency_code: "usd",
        })

        const [taxRegion] = await taxModule.createTaxRegions([
          {
            country_code: "US",
            provider_id: "tp_system",
            default_tax_rate: {
              name: "US Default Rate",
              rate: 5,
              code: "US_DEF",
            },
          },
        ])

        const [taxRate] = await taxModule.createTaxRates([
          {
            tax_region_id: taxRegion.id,
            name: "US Reduced",
            rate: 3,
            code: "USREDUCE_PROD_TYPE",
          },
        ])

        await taxModule.createTaxRateRules([
          {
            reference: "product_type",
            reference_id: productType.id,
            tax_rate_id: taxRate.id,
          },
        ])

        const salesChannel = await scModuleService.createSalesChannels({
          name: "Webshop",
        })

        const location = await stockLocationModule.createStockLocations({
          name: "Warehouse",
        })

        const [product] = await productModule.createProducts([
          {
            title: "Test product",
            status: ProductStatus.PUBLISHED,
            type_id: productType.id,
            variants: [
              {
                title: "Test variant",
              },
            ],
          },
        ])

        const inventoryItem = await inventoryModule.createInventoryItems({
          sku: "inv-1234",
        })

        await inventoryModule.createInventoryLevels([
          {
            inventory_item_id: inventoryItem.id,
            location_id: location.id,
            stocked_quantity: 2,
            reserved_quantity: 0,
          },
        ])

        const [priceSet] = await pricingModule.createPriceSets([
          {
            prices: [
              {
                amount: 3000,
                currency_code: "usd",
              },
            ],
          },
        ])

        await api.post(
          "/admin/price-preferences",
          {
            attribute: "currency_code",
            value: "usd",
            is_tax_inclusive: true,
          },
          adminHeaders
        )

        /**
         * Create a promotion to test with
         */
        const promotion = (
          await api.post(
            `/admin/promotions`,
            {
              code: "testytest",
              type: PromotionType.STANDARD,
              status: PromotionStatus.ACTIVE,
              application_method: {
                target_type: "items",
                type: "fixed",
                allocation: "each",
                currency_code: "usd",
                value: 100,
                max_quantity: 100,
                target_rules: [
                  {
                    attribute: "items.variant_id",
                    operator: "in",
                    values: [product.variants[0].id],
                  },
                ],
              },
            },
            adminHeaders
          )
        ).data.promotion

        await remoteLink.create([
          {
            [Modules.PRODUCT]: {
              variant_id: product.variants[0].id,
            },
            [Modules.PRICING]: {
              price_set_id: priceSet.id,
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
        ])

        const payload = {
          email: "oli@test.dk",
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          currency_code: "usd",
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
          promo_codes: ["testytest"],
          items: [
            {
              variant_id: product.variants[0].id,
              product_type_id: productType.id,
              quantity: 2,
            },
          ],
          shipping_methods: [
            {
              name: "test-method",
              shipping_option_id: "test-option",
              amount: 100,
            },
          ],
        }

        const response = await api.post(
          "/admin/draft-orders",
          payload,
          adminHeaders
        )

        expect(response.data.draft_order.items[0].tax_lines[0].code).toEqual(
          "USREDUCE_PROD_TYPE"
        )
        expect(response.data.draft_order.items[0].tax_lines[0].rate).toEqual(3)
      })
    })
  },
})
