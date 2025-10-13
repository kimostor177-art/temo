import React from "react"
import { Badge, Tooltip } from "@/components"

export type VersionNoticeProps = {
  version: string
  tooltipTextClassName?: string
  badgeClassName?: string
  badgeContent?: React.ReactNode
}

export const VersionNotice = ({
  version,
  tooltipTextClassName,
  badgeClassName,
  badgeContent = `v${version}`,
}: VersionNoticeProps) => {
  return (
    <Tooltip
      tooltipChildren={
        <span className={tooltipTextClassName}>
          This is available starting from
          <br />
          <a
            href={`https://github.com/medusajs/medusa/releases/tag/${version}`}
          >
            Medusa v{version}
          </a>
        </span>
      }
      clickable
    >
      <Badge variant="blue" className={badgeClassName}>
        {badgeContent}
      </Badge>
    </Tooltip>
  )
}
