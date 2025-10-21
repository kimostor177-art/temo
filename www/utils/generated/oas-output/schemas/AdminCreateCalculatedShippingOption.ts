/**
 * @schema AdminCreateCalculatedShippingOption
 * type: object
 * description: The calculated shipping option's details.
 * x-schemaName: AdminCreateCalculatedShippingOption
 * required:
 *   - price_type
 *   - name
 *   - service_zone_id
 *   - shipping_profile_id
 *   - provider_id
 * properties:
 *   price_type:
 *     type: string
 *     title: price_type
 *     description: The calculated shipping option's price type.
 *     enum:
 *       - calculated
 *       - flat
 *   name:
 *     type: string
 *     title: name
 *     description: The calculated shipping option's name.
 *   service_zone_id:
 *     type: string
 *     title: service_zone_id
 *     description: The ID of the associated service zone.
 *   shipping_profile_id:
 *     type: string
 *     title: shipping_profile_id
 *     description: The ID of the associated shipping profile.
 *   data:
 *     type: object
 *     description: The calculated shipping option's data.
 *     externalDocs:
 *       url: https://docs.medusajs.com/resources/commerce-modules/fulfillment/shipping-option#data-property
 *   provider_id:
 *     type: string
 *     title: provider_id
 *     description: The ID of the fulfillment provider handling this calculated shipping option.
 *   type:
 *     $ref: "#/components/schemas/AdminCreateShippingOptionType"
 *   type_id:
 *     type: string
 *     title: type_id
 *     description: The ID of the shipping option type that this shipping option belongs to.
 *   rules:
 *     type: array
 *     description: The calculated shipping option's rules.
 *     items:
 *       $ref: "#/components/schemas/AdminCreateShippingOptionRule"
 *   metadata:
 *     type: object
 *     description: The shipping option's metadata, can hold custom key-value pairs.
 * 
*/

