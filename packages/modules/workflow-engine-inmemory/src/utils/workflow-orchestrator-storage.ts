import { raw } from "@medusajs/framework/mikro-orm/core"
import {
  DistributedTransactionType,
  IDistributedSchedulerStorage,
  IDistributedTransactionStorage,
  SchedulerOptions,
  SkipCancelledExecutionError,
  SkipExecutionError,
  SkipStepAlreadyFinishedError,
  TransactionCheckpoint,
  TransactionContext,
  TransactionFlow,
  TransactionOptions,
  TransactionStep,
  TransactionStepError,
} from "@medusajs/framework/orchestration"
import {
  InferEntityType,
  Logger,
  ModulesSdkTypes,
} from "@medusajs/framework/types"
import {
  MedusaError,
  TransactionState,
  TransactionStepState,
  isPresent,
} from "@medusajs/framework/utils"
import { WorkflowOrchestratorService } from "@services"
import { type CronExpression, parseExpression } from "cron-parser"
import { WorkflowExecution } from "../models/workflow-execution"

const THIRTY_MINUTES_IN_MS = 1000 * 60 * 30

function calculateDelayFromExpression(expression: CronExpression): number {
  const nextTime = expression.next().getTime()
  const now = Date.now()
  const delay = nextTime - now

  // If the calculated delay is negative or zero, get the next occurrence
  if (delay <= 0) {
    const nextNextTime = expression.next().getTime()
    return Math.max(1, nextNextTime - now)
  }

  return delay
}

function parseNextExecution(
  optionsOrExpression: SchedulerOptions | CronExpression | string | number
) {
  if (typeof optionsOrExpression === "object") {
    if ("cron" in optionsOrExpression) {
      const expression = parseExpression(optionsOrExpression.cron)
      return calculateDelayFromExpression(expression)
    }

    if ("interval" in optionsOrExpression) {
      return optionsOrExpression.interval
    }

    return calculateDelayFromExpression(optionsOrExpression)
  }

  const result = parseInt(`${optionsOrExpression}`)

  if (isNaN(result)) {
    const expression = parseExpression(`${optionsOrExpression}`)
    return calculateDelayFromExpression(expression)
  }

  return result
}

const invokingStatesSet = new Set([
  TransactionStepState.INVOKING,
  TransactionStepState.NOT_STARTED,
])

const compensatingStatesSet = new Set([
  TransactionStepState.COMPENSATING,
  TransactionStepState.NOT_STARTED,
])

function isInvokingState(step: TransactionStep) {
  return invokingStatesSet.has(step.invoke?.state)
}

function isCompensatingState(step: TransactionStep) {
  return compensatingStatesSet.has(step.compensate?.state)
}

export class InMemoryDistributedTransactionStorage
  implements IDistributedTransactionStorage, IDistributedSchedulerStorage
{
  private workflowExecutionService_: ModulesSdkTypes.IMedusaInternalService<any>
  private logger_: Logger
  private workflowOrchestratorService_: WorkflowOrchestratorService

  private storage: Map<string, Omit<TransactionCheckpoint, "context">> =
    new Map()
  private scheduled: Map<
    string,
    {
      timer: NodeJS.Timeout
      expression: CronExpression | number
      numberOfExecutions: number
      config: SchedulerOptions
    }
  > = new Map()
  private retries: Map<string, NodeJS.Timeout> = new Map()
  private timeouts: Map<string, NodeJS.Timeout> = new Map()
  private pendingTimers: Set<NodeJS.Timeout> = new Set()

  private clearTimeout_: NodeJS.Timeout

  constructor({
    workflowExecutionService,
    logger,
  }: {
    workflowExecutionService: ModulesSdkTypes.IMedusaInternalService<any>
    logger: Logger
  }) {
    this.workflowExecutionService_ = workflowExecutionService
    this.logger_ = logger
  }

  async onApplicationStart() {
    this.clearTimeout_ = setInterval(async () => {
      try {
        await this.clearExpiredExecutions()
      } catch {}
    }, THIRTY_MINUTES_IN_MS)
  }

  async onApplicationShutdown() {
    clearInterval(this.clearTimeout_)

    for (const timer of this.pendingTimers) {
      clearTimeout(timer)
    }
    this.pendingTimers.clear()

    for (const timer of this.retries.values()) {
      clearTimeout(timer)
    }
    this.retries.clear()

    for (const timer of this.timeouts.values()) {
      clearTimeout(timer)
    }
    this.timeouts.clear()

    // Clean up scheduled job timers
    for (const job of this.scheduled.values()) {
      clearTimeout(job.timer)
    }
    this.scheduled.clear()
  }

  setWorkflowOrchestratorService(workflowOrchestratorService) {
    this.workflowOrchestratorService_ = workflowOrchestratorService
  }

  private createManagedTimer(
    callback: () => void | Promise<void>,
    delay: number
  ): NodeJS.Timeout {
    const timer = setTimeout(async () => {
      this.pendingTimers.delete(timer)
      const res = callback()
      if (res instanceof Promise) {
        await res
      }
    }, delay)

    this.pendingTimers.add(timer)
    return timer
  }

  private async saveToDb(data: TransactionCheckpoint, retentionTime?: number) {
    const isNotStarted = data.flow.state === TransactionState.NOT_STARTED
    const isFinished = [
      TransactionState.DONE,
      TransactionState.FAILED,
      TransactionState.REVERTED,
    ].includes(data.flow.state)

    /**
     * Bit of explanation:
     *
     * When a workflow run, it run all sync step in memory until it reaches a async step.
     * In that case, it might handover to another process to continue the execution. Thats why
     * we need to save the current state of the flow. Then from there, it will run again all
     * sync steps until the next async step. an so on so forth.
     *
     * To summarize, we only trully need to save the data when we are reaching any steps that
     * trigger a handover to a potential other process.
     *
     * This allows us to spare some resources and time by not over communicating with the external
     * database when it is not really needed
     */

    const isFlowInvoking = data.flow.state === TransactionState.INVOKING

    const stepsArray = Object.values(data.flow.steps) as TransactionStep[]
    let currentStep!: TransactionStep

    const targetStates = isFlowInvoking
      ? [
          TransactionStepState.INVOKING,
          TransactionStepState.DONE,
          TransactionStepState.FAILED,
        ]
      : [TransactionStepState.COMPENSATING]

    // Find the current step from the end
    for (let i = stepsArray.length - 1; i >= 0; i--) {
      const step = stepsArray[i]

      if (step.id === "_root") {
        break
      }

      const isTargetState = targetStates.includes(step.invoke?.state)

      if (isTargetState) {
        currentStep = step
        break
      }
    }

    const currentStepsIsAsync = currentStep
      ? stepsArray.some(
          (step) =>
            step?.definition?.async === true && step.depth === currentStep.depth
        )
      : false

    if (!(isNotStarted || isFinished) && !currentStepsIsAsync) {
      return
    }

    await this.workflowExecutionService_.upsert([
      {
        workflow_id: data.flow.modelId,
        transaction_id: data.flow.transactionId,
        run_id: data.flow.runId,
        execution: data.flow,
        context: {
          data: data.context,
          errors: data.errors,
        },
        state: data.flow.state,
        retention_time: retentionTime,
      },
    ])
  }

  private async deleteFromDb(data: TransactionCheckpoint) {
    await this.workflowExecutionService_.delete([
      {
        run_id: data.flow.runId,
      },
    ])
  }

  async get(
    key: string,
    options?: TransactionOptions & {
      isCancelling?: boolean
    }
  ): Promise<TransactionCheckpoint | undefined> {
    const [_, workflowId, transactionId] = key.split(":")
    const trx: InferEntityType<typeof WorkflowExecution> | undefined =
      await this.workflowExecutionService_
        .list(
          {
            workflow_id: workflowId,
            transaction_id: transactionId,
          },
          {
            select: ["execution", "context"],
            order: {
              id: "desc",
            },
            take: 1,
          }
        )
        .then((trx) => trx[0])
        .catch(() => undefined)

    if (trx) {
      const { flow, errors } = this.storage.get(key) ?? {}
      const { idempotent } = options ?? {}
      const execution = trx.execution as TransactionFlow

      if (!idempotent) {
        const isFailedOrReverted = [
          TransactionState.REVERTED,
          TransactionState.FAILED,
        ].includes(execution.state)

        const isDone = execution.state === TransactionState.DONE

        const isCancellingAndFailedOrReverted =
          options?.isCancelling && isFailedOrReverted

        const isNotCancellingAndDoneOrFailedOrReverted =
          !options?.isCancelling && (isDone || isFailedOrReverted)

        if (
          isCancellingAndFailedOrReverted ||
          isNotCancellingAndDoneOrFailedOrReverted
        ) {
          return
        }
      }

      return {
        flow: flow ?? (trx.execution as TransactionFlow),
        context: trx.context?.data as TransactionContext,
        errors: errors ?? (trx.context?.errors as TransactionStepError[]),
      }
    }

    return
  }

  async save(
    key: string,
    data: TransactionCheckpoint,
    ttl?: number,
    options?: TransactionOptions
  ): Promise<void> {
    /**
     * Store the retention time only if the transaction is done, failed or reverted.
     * From that moment, this tuple can be later on archived or deleted after the retention time.
     */
    const hasFinished = [
      TransactionState.DONE,
      TransactionState.FAILED,
      TransactionState.REVERTED,
    ].includes(data.flow.state)

    const { retentionTime } = options ?? {}

    await this.#preventRaceConditionExecutionIfNecessary({
      data,
      key,
      options,
    })

    // Only store retention time if it's provided
    if (retentionTime) {
      Object.assign(data, {
        retention_time: retentionTime,
      })
    }

    // Store in memory
    const isNotStarted = data.flow.state === TransactionState.NOT_STARTED
    const isManualTransactionId = !data.flow.transactionId.startsWith("auto-")

    if (isNotStarted && isManualTransactionId) {
      const storedData = this.storage.get(key)
      if (storedData) {
        throw new SkipExecutionError(
          "Transaction already started for transactionId: " +
            data.flow.transactionId
        )
      }
    }

    const { flow, errors } = data
    this.storage.set(key, {
      flow,
      errors,
    })

    // Optimize DB operations - only perform when necessary
    if (hasFinished) {
      if (!retentionTime) {
        // If the workflow is nested, we cant just remove it because it would break the compensation algorithm. Instead, it will get deleted when the top level parent is deleted.
        if (!flow.metadata?.parentStepIdempotencyKey) {
          await this.deleteFromDb(data)
        } else {
          await this.saveToDb(data, retentionTime)
        }
      } else {
        await this.saveToDb(data, retentionTime)
      }

      this.storage.delete(key)
    } else {
      await this.saveToDb(data, retentionTime)
    }
  }

  async #preventRaceConditionExecutionIfNecessary({
    data,
    key,
    options,
  }: {
    data: TransactionCheckpoint
    key: string
    options?: TransactionOptions
  }) {
    // TODO: comment, we have been able to try to replace this entire function
    // with a locking first approach. We might come back to that another time.
    // This remove the necessity of all the below logic to prevent race conditions
    // by preventing the exact same execution to run at the same time.
    // See early commits from: https://github.com/medusajs/medusa/pull/13345/commits

    const isInitialCheckpoint = [TransactionState.NOT_STARTED].includes(
      data.flow.state
    )

    /**
     * In case many execution can succeed simultaneously, we need to ensure that the latest
     * execution does continue if a previous execution is considered finished
     */
    const currentFlow = data.flow

    const rawData = this.storage.get(key)
    let data_ = {} as TransactionCheckpoint
    if (rawData) {
      data_ = rawData as TransactionCheckpoint
    } else {
      const getOptions = {
        ...options,
        isCancelling: !!data.flow.cancelledAt,
      } as Parameters<typeof this.get>[1]

      data_ =
        (await this.get(key, getOptions)) ??
        ({ flow: {} } as TransactionCheckpoint)
    }

    const { flow: latestUpdatedFlow } = data_

    if (!isInitialCheckpoint && !isPresent(latestUpdatedFlow)) {
      /**
       * the initial checkpoint expect no other checkpoint to have been stored.
       * In case it is not the initial one and another checkpoint is trying to
       * find if a concurrent execution has finished, we skip the execution.
       * The already finished execution would have deleted the checkpoint already.
       */
      throw new SkipExecutionError("Already finished by another execution")
    }

    let currentFlowLatestExecutedStep: TransactionStep | undefined
    const currentFlowSteps = Object.values(currentFlow.steps || {})
    for (let i = currentFlowSteps.length - 1; i >= 0; i--) {
      if (currentFlowSteps[i].lastAttempt) {
        currentFlowLatestExecutedStep = currentFlowSteps[i]
        break
      }
    }

    let latestUpdatedFlowLatestExecutedStep: TransactionStep | undefined
    const latestUpdatedFlowSteps = Object.values(latestUpdatedFlow.steps || {})
    for (let i = latestUpdatedFlowSteps.length - 1; i >= 0; i--) {
      if (latestUpdatedFlowSteps[i].lastAttempt) {
        latestUpdatedFlowLatestExecutedStep = latestUpdatedFlowSteps[i]
        break
      }
    }

    /**
     * The current flow and the latest updated flow have the same latest executed step.
     */
    const isSameLatestExecutedStep =
      currentFlowLatestExecutedStep &&
      latestUpdatedFlowLatestExecutedStep &&
      currentFlowLatestExecutedStep?.id ===
        latestUpdatedFlowLatestExecutedStep?.id

    /**
     * The current flow's latest executed step has a last attempt ahead of the latest updated
     * flow's latest executed step. Therefor it is fine, otherwise another execution has already
     * finished the step.
     */
    const isCurrentLatestExecutedStepLastAttemptAhead =
      currentFlowLatestExecutedStep?.lastAttempt &&
      latestUpdatedFlowLatestExecutedStep?.lastAttempt &&
      currentFlowLatestExecutedStep.lastAttempt >=
        latestUpdatedFlowLatestExecutedStep.lastAttempt

    if (
      isSameLatestExecutedStep &&
      !isCurrentLatestExecutedStepLastAttemptAhead
    ) {
      throw new SkipStepAlreadyFinishedError(
        "Step already in execution ahead of the current one"
      )
    }

    // First ensure that the latest execution was not cancelled, otherwise we skip the execution
    const latestTransactionCancelledAt = latestUpdatedFlow.cancelledAt
    const currentTransactionCancelledAt = currentFlow.cancelledAt

    if (
      !!latestTransactionCancelledAt &&
      currentTransactionCancelledAt == null
    ) {
      throw new SkipCancelledExecutionError(
        "Workflow execution has been cancelled during the execution"
      )
    }

    const currentFlowLastInvokingStepIndex =
      currentFlowSteps.findIndex(isInvokingState)

    let latestUpdatedFlowLastInvokingStepIndex = !latestUpdatedFlow.steps
      ? 1 // There is no other execution, so the current execution is the latest
      : -1

    if (latestUpdatedFlow.steps) {
      for (let i = 0; i < latestUpdatedFlowSteps.length; i++) {
        if (isInvokingState(latestUpdatedFlowSteps[i])) {
          latestUpdatedFlowLastInvokingStepIndex = i
          break
        }
      }
    }

    let currentFlowLastCompensatingStepIndex = -1
    for (let i = currentFlowSteps.length - 1; i >= 0; i--) {
      if (isCompensatingState(currentFlowSteps[i])) {
        currentFlowLastCompensatingStepIndex = currentFlowSteps.length - 1 - i
        break
      }
    }

    let latestUpdatedFlowLastCompensatingStepIndex = !latestUpdatedFlow.steps
      ? -1 // There is no other execution, so the current execution is the latest
      : -1

    if (latestUpdatedFlow.steps) {
      for (let i = latestUpdatedFlowSteps.length - 1; i >= 0; i--) {
        if (isCompensatingState(latestUpdatedFlowSteps[i])) {
          latestUpdatedFlowLastCompensatingStepIndex =
            latestUpdatedFlowSteps.length - 1 - i
          break
        }
      }
    }

    const isLatestExecutionFinishedIndex = -1
    const invokeShouldBeSkipped =
      (latestUpdatedFlowLastInvokingStepIndex ===
        isLatestExecutionFinishedIndex ||
        currentFlowLastInvokingStepIndex <
          latestUpdatedFlowLastInvokingStepIndex) &&
      currentFlowLastInvokingStepIndex !== isLatestExecutionFinishedIndex

    const compensateShouldBeSkipped =
      currentFlowLastCompensatingStepIndex <
        latestUpdatedFlowLastCompensatingStepIndex &&
      currentFlowLastCompensatingStepIndex !== isLatestExecutionFinishedIndex &&
      latestUpdatedFlowLastCompensatingStepIndex !==
        isLatestExecutionFinishedIndex

    const isCompensatingMismatch =
      latestUpdatedFlow.state === TransactionState.COMPENSATING &&
      ![TransactionState.REVERTED, TransactionState.FAILED].includes(
        currentFlow.state
      ) &&
      currentFlow.state !== latestUpdatedFlow.state

    const isRevertedMismatch =
      latestUpdatedFlow.state === TransactionState.REVERTED &&
      currentFlow.state !== TransactionState.REVERTED

    const isFailedMismatch =
      latestUpdatedFlow.state === TransactionState.FAILED &&
      currentFlow.state !== TransactionState.FAILED

    if (
      (data.flow.state !== TransactionState.COMPENSATING &&
        invokeShouldBeSkipped) ||
      (data.flow.state === TransactionState.COMPENSATING &&
        compensateShouldBeSkipped) ||
      isCompensatingMismatch ||
      isRevertedMismatch ||
      isFailedMismatch
    ) {
      throw new SkipExecutionError("Already finished by another execution")
    }
  }

  async scheduleRetry(
    transaction: DistributedTransactionType,
    step: TransactionStep,
    timestamp: number,
    interval: number
  ): Promise<void> {
    const { modelId: workflowId, transactionId } = transaction
    const key = `${workflowId}:${transactionId}:${step.id}`

    const existingTimer = this.retries.get(key)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.pendingTimers.delete(existingTimer)
    }

    const timer = this.createManagedTimer(async () => {
      this.retries.delete(key)
      const context = transaction.getFlow().metadata ?? {}
      await this.workflowOrchestratorService_.run(workflowId, {
        transactionId,
        logOnError: true,
        throwOnError: false,
        context: {
          eventGroupId: context.eventGroupId,
          parentStepIdempotencyKey: context.parentStepIdempotencyKey,
          preventReleaseEvents: context.preventReleaseEvents,
        },
      })
    }, interval * 1e3)

    this.retries.set(key, timer)
  }

  async clearRetry(
    transaction: DistributedTransactionType,
    step: TransactionStep
  ): Promise<void> {
    const { modelId: workflowId, transactionId } = transaction

    const key = `${workflowId}:${transactionId}:${step.id}`
    const timer = this.retries.get(key)
    if (timer) {
      clearTimeout(timer)
      this.pendingTimers.delete(timer)
      this.retries.delete(key)
    }
  }

  async scheduleTransactionTimeout(
    transaction: DistributedTransactionType,
    timestamp: number,
    interval: number
  ): Promise<void> {
    const { modelId: workflowId, transactionId } = transaction
    const key = `${workflowId}:${transactionId}`

    const existingTimer = this.timeouts.get(key)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.pendingTimers.delete(existingTimer)
    }

    const timer = this.createManagedTimer(async () => {
      this.timeouts.delete(key)
      const context = transaction.getFlow().metadata ?? {}
      await this.workflowOrchestratorService_.run(workflowId, {
        transactionId,
        logOnError: true,
        throwOnError: false,
        context: {
          eventGroupId: context.eventGroupId,
          parentStepIdempotencyKey: context.parentStepIdempotencyKey,
          preventReleaseEvents: context.preventReleaseEvents,
        },
      })
    }, interval * 1e3)

    this.timeouts.set(key, timer)
  }

  async clearTransactionTimeout(
    transaction: DistributedTransactionType
  ): Promise<void> {
    const { modelId: workflowId, transactionId } = transaction

    const key = `${workflowId}:${transactionId}`
    const timer = this.timeouts.get(key)
    if (timer) {
      clearTimeout(timer)
      this.pendingTimers.delete(timer)
      this.timeouts.delete(key)
    }
  }

  async scheduleStepTimeout(
    transaction: DistributedTransactionType,
    step: TransactionStep,
    timestamp: number,
    interval: number
  ): Promise<void> {
    const { modelId: workflowId, transactionId } = transaction
    const key = `${workflowId}:${transactionId}:${step.id}`

    const existingTimer = this.timeouts.get(key)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.pendingTimers.delete(existingTimer)
    }

    const timer = this.createManagedTimer(async () => {
      this.timeouts.delete(key)
      const context = transaction.getFlow().metadata ?? {}
      await this.workflowOrchestratorService_.run(workflowId, {
        transactionId,
        logOnError: true,
        throwOnError: false,
        context: {
          eventGroupId: context.eventGroupId,
          parentStepIdempotencyKey: context.parentStepIdempotencyKey,
          preventReleaseEvents: context.preventReleaseEvents,
        },
      })
    }, interval * 1e3)

    this.timeouts.set(key, timer)
  }

  async clearStepTimeout(
    transaction: DistributedTransactionType,
    step: TransactionStep
  ): Promise<void> {
    const { modelId: workflowId, transactionId } = transaction

    const key = `${workflowId}:${transactionId}:${step.id}`
    const timer = this.timeouts.get(key)
    if (timer) {
      clearTimeout(timer)
      this.pendingTimers.delete(timer)
      this.timeouts.delete(key)
    }
  }

  /* Scheduler storage methods */
  async schedule(
    jobDefinition: string | { jobId: string },
    schedulerOptions: SchedulerOptions
  ): Promise<void> {
    const jobId =
      typeof jobDefinition === "string" ? jobDefinition : jobDefinition.jobId

    // In order to ensure that the schedule configuration is always up to date, we first cancel an existing job, if there was one
    await this.remove(jobId)

    let expression: CronExpression | number
    let nextExecution = parseNextExecution(schedulerOptions)

    if ("cron" in schedulerOptions) {
      // Cache the parsed expression to avoid repeated parsing
      expression = parseExpression(schedulerOptions.cron)
    } else if ("interval" in schedulerOptions) {
      expression = schedulerOptions.interval
    } else {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Schedule cron or interval definition is required for scheduled jobs."
      )
    }

    const timer = setTimeout(async () => {
      this.jobHandler(jobId)
    }, nextExecution)

    // Set the timer's unref to prevent it from keeping the process alive
    timer.unref()

    this.scheduled.set(jobId, {
      timer,
      expression,
      numberOfExecutions: 0,
      config: schedulerOptions,
    })
  }

  async remove(jobId: string): Promise<void> {
    const job = this.scheduled.get(jobId)
    if (!job) {
      return
    }

    clearTimeout(job.timer)
    this.scheduled.delete(jobId)
  }

  async removeAll(): Promise<void> {
    for (const [key] of this.scheduled) {
      await this.remove(key)
    }
  }

  async jobHandler(jobId: string) {
    const job = this.scheduled.get(jobId)
    if (!job) {
      return
    }

    if (
      job.config?.numberOfExecutions !== undefined &&
      job.config.numberOfExecutions <= job.numberOfExecutions
    ) {
      this.scheduled.delete(jobId)
      return
    }

    const nextExecution = parseNextExecution(job.expression)

    try {
      await this.workflowOrchestratorService_.run(jobId, {
        logOnError: true,
        throwOnError: false,
      })

      const timer = this.createManagedTimer(() => {
        this.jobHandler(jobId)
      }, nextExecution)

      // Prevent timer from keeping the process alive
      timer.unref()

      this.scheduled.set(jobId, {
        timer,
        expression: job.expression,
        numberOfExecutions: (job.numberOfExecutions ?? 0) + 1,
        config: job.config,
      })
    } catch (e) {
      if (e instanceof MedusaError && e.type === MedusaError.Types.NOT_FOUND) {
        this.logger_?.warn(
          `Tried to execute a scheduled workflow with ID ${jobId} that does not exist, removing it from the scheduler.`
        )

        await this.remove(jobId)
        return
      }

      throw e
    }
  }

  async clearExpiredExecutions(): Promise<void> {
    await this.workflowExecutionService_.delete({
      retention_time: {
        $ne: null,
      },
      updated_at: {
        $lte: raw(
          (alias) =>
            `CURRENT_TIMESTAMP - (INTERVAL '1 second' * retention_time)`
        ),
      },
      state: {
        $in: [
          TransactionState.DONE,
          TransactionState.FAILED,
          TransactionState.REVERTED,
        ],
      },
    })
  }
}
