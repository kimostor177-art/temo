import Medusa from "@medusajs/js-sdk"

export const sdk = new Medusa({
  baseUrl: import.meta.env.VITE_BACKEND_URL || "/",
  debug: import.meta.env.DEV,
  auth: {
    type: "session",
  },
})

sdk.admin.refundReason.create({
  value: "refund",
  label: "Refund",
})
.then(({ refund_reason }) => {
  console.log(refund_reason)
})