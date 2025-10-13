import React from "react"
import { Badge, Tooltip } from "@/components"

export type FeatureFlagNoticeProps = {
  featureFlag: string
  type?: "endpoint" | "type"
  tooltipTextClassName?: string
  badgeClassName?: string
  badgeContent?: React.ReactNode
}

export const FeatureFlagNotice = ({
  featureFlag,
  type = "endpoint",
  tooltipTextClassName,
  badgeClassName,
  badgeContent = "feature flag",
}: FeatureFlagNoticeProps) => {
  return (
    <Tooltip
      tooltipChildren={
        <span className={tooltipTextClassName}>
          To use this {type}, make sure to
          <br />
          {/* TODO add doc link once available */}
          enable its feature flag: <code>{featureFlag}</code>
        </span>
      }
      clickable
    >
      <Badge variant="green" className={badgeClassName}>
        {badgeContent}
      </Badge>
    </Tooltip>
  )
}
