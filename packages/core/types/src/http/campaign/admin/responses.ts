import { CampaignBudgetTypeValues } from "../../../promotion"
import { DeleteResponse, PaginatedResponse } from "../../common"

export interface AdminCampaign {
  /**
   * The campaign's ID.
   */
  id: string
  /**
   * The campaign's name.
   */
  name: string
  /**
   * The campaign's description.
   */
  description: string
  /**
   * The campaign's currency code.
   *
   * @example
   * usd
   */
  currency: string
  /**
   * The campaign's identifier.
   */
  campaign_identifier: string
  /**
   * The date the campaign and its promotions start at.
   */
  starts_at: string
  /**
   * The date the campaign and its promotions end at.
   */
  ends_at: string
  /**
   * The campaign's budget.
   */
  budget: {
    /**
     * The budget's ID.
     */
    id: string
    /**
     * The budget's type. `spend` means the limit is set on the total amount discounted by the campaign's promotions;
     * `usage` means the limit is set on the total number of times the campaign's promotions can be used.
     */
    type: CampaignBudgetTypeValues
    /**
     * The budget's currency code.
     *
     * @example
     * usd
     */
    currency_code: string
    /**
     * The budget's limit.
     */
    limit: number
    /**
     * How much of the budget has been used. If the limit is `spend`, this property holds the total amount
     * discounted so far. If the limit is `usage`, it holds the number of times the campaign's
     * promotions have been used so far.
     */
    used: number
    /**
     * The attribute that the budget limit is applied to. By default,
     * the budget is applied globally. If the type is `use_by_attribute`, this field indicates the 
     * attribute the budget is tracked by. For example, `customer_id` means the budget is tracked per customer.
     *
     * @example
     * customer_id
     * @since 2.11.0
     */
    attribute: string
  }
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type AdminCampaignListResponse = PaginatedResponse<{
  campaigns: AdminCampaign[]
}>

export interface AdminCampaignResponse {
  /**
   * The campaign's details.
   */
  campaign: AdminCampaign
}

export type AdminCampaignDeleteResponse = DeleteResponse<"campaign">
