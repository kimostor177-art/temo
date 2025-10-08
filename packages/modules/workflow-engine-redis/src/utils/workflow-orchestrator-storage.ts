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
import { Logger, ModulesSdkTypes } from "@medusajs/framework/types"
import {
  isPresent,
  MedusaError,
  promiseAll,
  TransactionState,
  TransactionStepState,
} from "@medusajs/framework/utils"
import { WorkflowOrchestratorService } from "@services"
import { Queue, RepeatOptions, Worker } from "bullmq"
import Redis from "ioredis"

enum JobType {
  SCHEDULE = "schedule",
  RETRY = "retry",
  STEP_TIMEOUT = "step_timeout",
  TRANSACTION_TIMEOUT = "transaction_timeout",
}

const THIRTY_MINUTES_IN_MS = 1000 * 60 * 30
const REPEATABLE_CLEARER_JOB_ID = "clear-expired-executions"

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

export class RedisDistributedTransactionStorage
  implements IDistributedTransactionStorage, IDistributedSchedulerStorage
{
  private workflowExecutionService_: ModulesSdkTypes.IMedusaInternalService<any>
  private logger_: Logger
  private workflowOrchestratorService_: WorkflowOrchestratorService

  private redisClient: Redis
  private redisWorkerConnection: Redis
  private queueName: string
  private jobQueueName: string
  private queue: Queue
  private jobQueue?: Queue
  private worker: Worker
  private jobWorker?: Worker
  private cleanerQueueName: string
  private cleanerWorker_: Worker
  private cleanerQueue_?: Queue

  #isWorkerMode: boolean = false

  constructor({
    workflowExecutionService,
    redisConnection,
    redisWorkerConnection,
    redisQueueName,
    redisJobQueueName,
    logger,
    isWorkerMode,
  }: {
    workflowExecutionService: ModulesSdkTypes.IMedusaInternalService<any>
    redisConnection: Redis
    redisWorkerConnection: Redis
    redisQueueName: string
    redisJobQueueName: string
    logger: Logger
    isWorkerMode: boolean
  }) {
    this.workflowExecutionService_ = workflowExecutionService
    this.logger_ = logger
    this.redisClient = redisConnection
    this.redisWorkerConnection = redisWorkerConnection
    this.cleanerQueueName = "workflows-cleaner"
    this.queueName = redisQueueName
    this.jobQueueName = redisJobQueueName
    this.queue = new Queue(redisQueueName, { connection: this.redisClient })
    this.jobQueue = isWorkerMode
      ? new Queue(redisJobQueueName, {
          connection: this.redisClient,
        })
      : undefined
    this.cleanerQueue_ = isWorkerMode
      ? new Queue(this.cleanerQueueName, {
          connection: this.redisClient,
        })
      : undefined
    this.#isWorkerMode = isWorkerMode
  }

  async onApplicationPrepareShutdown() {
    // Close worker gracefully, i.e. wait for the current jobs to finish
    await this.worker?.close()
    await this.jobWorker?.close()

    await this.cleanerWorker_?.close()
  }

  async onApplicationShutdown() {
    await this.queue?.close()
    await this.jobQueue?.close()
    await this.cleanerQueue_?.close()
  }

  async onApplicationStart() {
    await this.ensureRedisConnection()
    const allowedJobs = [
      JobType.RETRY,
      JobType.STEP_TIMEOUT,
      JobType.TRANSACTION_TIMEOUT,
    ]

    const workerOptions = {
      connection: this.redisWorkerConnection,
    }

    // TODO: Remove this once we have released to all clients (Added: v2.6+)
    // Remove all repeatable jobs from the old queue since now we have a queue dedicated to scheduled jobs
    await this.removeAllRepeatableJobs(this.queue)

    this.worker = new Worker(
      this.queueName,
      async (job) => {
        this.logger_.debug(
          `executing job ${job.name} from queue ${
            this.queueName
          } with the following data: ${JSON.stringify(job.data)}`
        )
        if (allowedJobs.includes(job.name as JobType)) {
          await this.executeTransaction(
            job.data.workflowId,
            job.data.transactionId,
            job.data.transactionMetadata
          )
        }

        if (job.name === JobType.SCHEDULE) {
          // Remove repeatable job from the old queue since now we have a queue dedicated to scheduled jobs
          await this.remove(job.data.jobId)
        }
      },
      workerOptions
    )

    if (this.#isWorkerMode) {
      this.jobWorker = new Worker(
        this.jobQueueName,
        async (job) => {
          this.logger_.debug(
            `executing scheduled job ${job.data.jobId} from queue ${
              this.jobQueueName
            } with the following options: ${JSON.stringify(
              job.data.schedulerOptions
            )}`
          )
          return await this.executeScheduledJob(
            job.data.jobId,
            job.data.schedulerOptions
          )
        },
        workerOptions
      )

      this.cleanerWorker_ = new Worker(
        this.cleanerQueueName,
        async () => {
          await this.clearExpiredExecutions()
        },
        workerOptions
      )

      await this.cleanerQueue_?.add(
        "cleaner",
        {},
        {
          repeat: {
            every: THIRTY_MINUTES_IN_MS,
          },
          jobId: REPEATABLE_CLEARER_JOB_ID,
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
    }
  }

  setWorkflowOrchestratorService(workflowOrchestratorService) {
    this.workflowOrchestratorService_ = workflowOrchestratorService
  }

  private async ensureRedisConnection(): Promise<void> {
    const reconnectTasks: Promise<void>[] = []

    if (this.redisClient.status !== "ready") {
      this.logger_.warn(
        `[Workflow-engine-redis] Redis connection is not ready (status: ${this.redisClient.status}). Attempting to reconnect...`
      )
      reconnectTasks.push(
        this.redisClient
          .connect()
          .then(() => {
            this.logger_.info(
              "[Workflow-engine-redis] Redis connection reestablished successfully"
            )
          })
          .catch((error) => {
            this.logger_.error(
              "[Workflow-engine-redis] Failed to reconnect to Redis",
              error
            )
            throw new MedusaError(
              MedusaError.Types.DB_ERROR,
              `Redis connection failed: ${error.message}`
            )
          })
      )
    }

    if (this.redisWorkerConnection.status !== "ready") {
      this.logger_.warn(
        `[Workflow-engine-redis] Redis worker connection is not ready (status: ${this.redisWorkerConnection.status}). Attempting to reconnect...`
      )
      reconnectTasks.push(
        this.redisWorkerConnection
          .connect()
          .then(() => {
            this.logger_.info(
              "[Workflow-engine-redis] Redis worker connection reestablished successfully"
            )
          })
          .catch((error) => {
            this.logger_.error(
              "[Workflow-engine-redis] Failed to reconnect to Redis worker connection",
              error
            )
            throw new MedusaError(
              MedusaError.Types.DB_ERROR,
              `Redis worker connection failed: ${error.message}`
            )
          })
      )
    }

    if (reconnectTasks.length > 0) {
      await promiseAll(reconnectTasks)
    }
  }

  private async saveToDb(data: TransactionCheckpoint, retentionTime?: number) {
    const isNotStarted = data.flow.state === TransactionState.NOT_STARTED
    const isFinished = [
      TransactionState.DONE,
      TransactionState.FAILED,
      TransactionState.REVERTED,
    ].includes(data.flow.state)
    const isWaitingToCompensate =
      data.flow.state === TransactionState.WAITING_TO_COMPENSATE

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

    if (
      !(isNotStarted || isFinished || isWaitingToCompensate) &&
      !currentStepsIsAsync
    ) {
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

  private async executeTransaction(
    workflowId: string,
    transactionId: string,
    transactionMetadata: TransactionFlow["metadata"] = {}
  ) {
    return await this.workflowOrchestratorService_.run(workflowId, {
      transactionId,
      logOnError: true,
      throwOnError: false,
      context: {
        eventGroupId: transactionMetadata.eventGroupId,
        parentStepIdempotencyKey: transactionMetadata.parentStepIdempotencyKey,
        preventReleaseEvents: transactionMetadata.preventReleaseEvents,
      },
    })
  }

  private async executeScheduledJob(
    jobId: string,
    schedulerOptions: SchedulerOptions
  ) {
    try {
      // TODO: In the case of concurrency being forbidden, we want to generate a predictable transaction ID and rely on the idempotency
      // of the transaction to ensure that the transaction is only executed once.
      await this.workflowOrchestratorService_.run(jobId, {
        logOnError: true,
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

  async get(
    key: string,
    options?: TransactionOptions & { isCancelling?: boolean }
  ): Promise<TransactionCheckpoint | undefined> {
    const [_, workflowId, transactionId] = key.split(":")
    const trx = await this.workflowExecutionService_
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
      const rawData = await this.redisClient.get(key)

      let flow!: TransactionFlow, errors!: TransactionStepError[]
      if (rawData) {
        const data = JSON.parse(rawData)
        flow = data.flow
        errors = data.errors
      }

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

    if (hasFinished && retentionTime) {
      Object.assign(data, {
        retention_time: retentionTime,
      })
    }

    // Only set if not exists
    const shouldSetNX =
      data.flow.state === TransactionState.NOT_STARTED &&
      !data.flow.transactionId.startsWith("auto-")

    // Prepare operations to be executed in batch or pipeline
    const data_ = {
      errors: data.errors,
      flow: data.flow,
    }
    const stringifiedData = JSON.stringify(data_)
    const pipeline = this.redisClient.pipeline()

    // Execute Redis operations
    if (!hasFinished) {
      if (ttl) {
        if (shouldSetNX) {
          pipeline.set(key, stringifiedData, "EX", ttl, "NX")
        } else {
          pipeline.set(key, stringifiedData, "EX", ttl)
        }
      } else {
        if (shouldSetNX) {
          pipeline.set(key, stringifiedData, "NX")
        } else {
          pipeline.set(key, stringifiedData)
        }
      }
    } else {
      pipeline.unlink(key)
    }

    const execPipeline = () => {
      return pipeline.exec().then((result) => {
        if (!shouldSetNX) {
          return result
        }

        const actionResult = result?.pop()
        const isOk = !!actionResult?.pop()
        if (!isOk) {
          throw new SkipExecutionError(
            "Transaction already started for transactionId: " +
              data.flow.transactionId
          )
        }

        return result
      })
    }

    // Database operations
    if (hasFinished && !retentionTime) {
      // If the workflow is nested, we cant just remove it because it would break the compensation algorithm. Instead, it will get deleted when the top level parent is deleted.
      if (!data.flow.metadata?.parentStepIdempotencyKey) {
        await promiseAll([execPipeline(), this.deleteFromDb(data)])
      } else {
        await this.saveToDb(data, retentionTime)
        await execPipeline()
      }
    } else {
      await this.saveToDb(data, retentionTime)
      await execPipeline()
    }
  }

  async scheduleRetry(
    transaction: DistributedTransactionType,
    step: TransactionStep,
    timestamp: number,
    interval: number
  ): Promise<void> {
    await this.queue.add(
      JobType.RETRY,
      {
        workflowId: transaction.modelId,
        transactionId: transaction.transactionId,
        transactionMetadata: transaction.getFlow().metadata,
        stepId: step.id,
      },
      {
        delay: interval > 0 ? interval * 1000 : undefined,
        jobId: this.getJobId(JobType.RETRY, transaction, step),
        removeOnComplete: true,
      }
    )
  }

  async clearRetry(
    transaction: DistributedTransactionType,
    step: TransactionStep
  ): Promise<void> {
    await this.removeJob(JobType.RETRY, transaction, step)
  }

  async scheduleTransactionTimeout(
    transaction: DistributedTransactionType,
    _: number,
    interval: number
  ): Promise<void> {
    await this.queue.add(
      JobType.TRANSACTION_TIMEOUT,
      {
        workflowId: transaction.modelId,
        transactionId: transaction.transactionId,
        transactionMetadata: transaction.getFlow().metadata,
      },
      {
        delay: interval * 1000,
        jobId: this.getJobId(JobType.TRANSACTION_TIMEOUT, transaction),
        removeOnComplete: true,
      }
    )
  }

  async clearTransactionTimeout(
    transaction: DistributedTransactionType
  ): Promise<void> {
    await this.removeJob(JobType.TRANSACTION_TIMEOUT, transaction)
  }

  async scheduleStepTimeout(
    transaction: DistributedTransactionType,
    step: TransactionStep,
    timestamp: number,
    interval: number
  ): Promise<void> {
    await this.queue.add(
      JobType.STEP_TIMEOUT,
      {
        workflowId: transaction.modelId,
        transactionId: transaction.transactionId,
        transactionMetadata: transaction.getFlow().metadata,
        stepId: step.id,
      },
      {
        delay: interval * 1000,
        jobId: this.getJobId(JobType.STEP_TIMEOUT, transaction, step),
        removeOnComplete: true,
      }
    )
  }

  async clearStepTimeout(
    transaction: DistributedTransactionType,
    step: TransactionStep
  ): Promise<void> {
    await this.removeJob(JobType.STEP_TIMEOUT, transaction, step)
  }

  private getJobId(
    type: JobType,
    transaction: DistributedTransactionType,
    step?: TransactionStep
  ) {
    const key = [type, transaction.modelId, transaction.transactionId]

    if (step) {
      key.push(step.id, step.attempts + "")
      if (step.isCompensating()) {
        key.push("compensate")
      }
    }

    return key.join(":")
  }

  private async removeJob(
    type: JobType,
    transaction: DistributedTransactionType,
    step?: TransactionStep
  ) {
    const jobId = this.getJobId(type, transaction, step)

    if (type === JobType.SCHEDULE) {
      const job = await this.jobQueue?.getJob(jobId)
      if (job) {
        await job.remove()
      }
    } else {
      const job = await this.queue.getJob(jobId)

      if (job && job.attemptsStarted === 0) {
        await job.remove()
      }
    }
  }

  /* Scheduler storage methods */
  async schedule(
    jobDefinition: string | { jobId: string },
    schedulerOptions: SchedulerOptions
  ): Promise<void> {
    const jobId =
      typeof jobDefinition === "string" ? jobDefinition : jobDefinition.jobId

    if ("cron" in schedulerOptions && "interval" in schedulerOptions) {
      throw new Error(
        `Unable to register a job with both scheduler options interval and cron.`
      )
    }

    const repeatOptions: RepeatOptions = {
      limit: schedulerOptions.numberOfExecutions,
      key: `${JobType.SCHEDULE}_${jobId}`,
    }

    if ("cron" in schedulerOptions) {
      repeatOptions.pattern = schedulerOptions.cron
    } else {
      repeatOptions.every = schedulerOptions.interval
    }

    // If it is the same key (eg. the same workflow name), the old one will get overridden.
    await this.jobQueue?.add(
      JobType.SCHEDULE,
      {
        jobId,
        schedulerOptions,
      },
      {
        repeat: repeatOptions,
        removeOnComplete: {
          age: 86400,
          count: 1000,
        },
        removeOnFail: {
          age: 604800,
          count: 5000,
        },
      }
    )
  }

  async remove(jobId: string): Promise<void> {
    await this.jobQueue?.removeRepeatableByKey(`${JobType.SCHEDULE}_${jobId}`)
  }

  async removeAll(): Promise<void> {
    return await this.removeAllRepeatableJobs(this.jobQueue!)
  }

  private async removeAllRepeatableJobs(queue: Queue): Promise<void> {
    const repeatableJobs = (await queue.getRepeatableJobs()) ?? []
    await promiseAll(
      repeatableJobs.map((job) => queue.removeRepeatableByKey(job.key))
    )
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
    const isInitialCheckpoint = [TransactionState.NOT_STARTED].includes(
      data.flow.state
    )

    /**
     * In case many execution can succeed simultaneously, we need to ensure that the latest
     * execution does continue if a previous execution is considered finished
     */
    const currentFlow = data.flow

    const rawData = await this.redisClient.get(key)
    let data_ = {} as TransactionCheckpoint
    if (rawData) {
      data_ = JSON.parse(rawData)
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
        "Step already finished by another execution"
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

    let currentFlowLastInvokingStepIndex = -1
    for (let i = 0; i < currentFlowSteps.length; i++) {
      if (isInvokingState(currentFlowSteps[i])) {
        currentFlowLastInvokingStepIndex = i
        break
      }
    }

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

  async clearExpiredExecutions() {
    await this.workflowExecutionService_.delete({
      retention_time: {
        $ne: null,
      },
      updated_at: {
        $lte: raw(
          (alias) =>
            `CURRENT_TIMESTAMP - (INTERVAL '1 second' * "retention_time")`
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
