import { OperatorMap } from "../../dal"
import { FindParams } from "../common"

export interface BaseRefundReason {
  /**
   * The refund reason's ID.
   */
  id: string
  /**
   * The refund reason's label.
   *
   * @example
   * "Refund"
   */
  label: string
  /**
   * The refund reason's description.
   */
  description?: string | null
  /**
   * Custom key-value pairs that can be added to the refund reason.
   */
  metadata?: Record<string, any> | null
  /**
   * The date that the refund reason was created.
   */
  created_at: string
  /**
   * The date that the refund reason was updated.
   */
  updated_at: string
}

export interface BaseRefundReasonListParams extends FindParams {
  q?: string
  id?: string | string[]
  label?: string | OperatorMap<string>
  description?: string | OperatorMap<string>
  parent_refund_reason_id?: string | OperatorMap<string | string[]>
  created_at?: OperatorMap<string>
  updated_at?: OperatorMap<string>
}
