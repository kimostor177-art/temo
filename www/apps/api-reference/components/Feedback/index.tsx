"use client"

import { Feedback as UiFeedback, FeedbackProps } from "docs-ui"
import { usePathname } from "next/navigation"
import { useArea } from "../../providers/area"

export const Feedback = (props: Partial<FeedbackProps>) => {
  const pathname = usePathname()
  const { area } = useArea()

  return (
    <UiFeedback
      vertical={true}
      {...props}
      event="survey_api-ref"
      extraData={{
        area,
        ...props.extraData,
      }}
      pathName={`/api/${pathname}`}
    />
  )
}
