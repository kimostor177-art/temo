import { PromotionUtils, model } from "@medusajs/framework/utils"
import Campaign from "./campaign"
import CampaignBudgetUsage from "./campaign-budget-usage"

const CampaignBudget = model
  .define(
    { name: "CampaignBudget", tableName: "promotion_campaign_budget" },
    {
      id: model.id({ prefix: "probudg" }).primaryKey(),
      type: model
        .enum(PromotionUtils.CampaignBudgetType)
        .index("IDX_campaign_budget_type"),
      currency_code: model.text().nullable(),
      limit: model.bigNumber().nullable(),
      used: model.bigNumber().default(0),
      campaign: model.belongsTo(() => Campaign, {
        mappedBy: "budget",
      }),

      attribute: model.text().nullable(), // e.g. "customer_id", "customer_email"

      // usages when budget type is "limit/use by attribute"
      usages: model.hasMany(() => CampaignBudgetUsage, {
        mappedBy: "budget",
      }),
    }
  )
  .cascades({
    delete: ["usages"],
  })

export default CampaignBudget
