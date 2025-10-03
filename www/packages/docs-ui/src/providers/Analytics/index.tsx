"use client"

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"
import { Analytics, AnalyticsBrowser } from "@segment/analytics-next"
import posthog from "posthog-js"

// @ts-expect-error Doesn't have a types package
import { loadReoScript } from "reodotdev"

export type ExtraData = {
  section?: string
  [key: string]: any
}

export type AnalyticsContextType = {
  loaded: boolean
  analytics: Analytics | null
  track: ({
    event,
    instant,
  }: {
    event: TrackedEvent
    instant?: boolean
  }) => void
}

type Trackers = "segment" | "posthog"

export type TrackedEvent = {
  event: string
  options?: Record<string, any>
  callback?: () => void
  tracker?: Trackers | Trackers[]
}

const AnalyticsContext = createContext<AnalyticsContextType | null>(null)

export type AnalyticsProviderProps = {
  segmentWriteKey?: string
  reoDevKey?: string
  children?: React.ReactNode
}

const LOCAL_STORAGE_KEY = "ajs_anonymous_id"

export const AnalyticsProvider = ({
  segmentWriteKey = "temp",
  reoDevKey,
  children,
}: AnalyticsProviderProps) => {
  // loaded is used to ensure that a connection has been made to segment
  // even if it failed. This is to ensure that the connection isn't
  // continuously retried
  const [loaded, setLoaded] = useState<boolean>(false)
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const analyticsBrowser = new AnalyticsBrowser()
  const [queue, setQueue] = useState<TrackedEvent[]>([])

  const initSegment = useCallback(() => {
    if (!loaded) {
      analyticsBrowser
        .load(
          { writeKey: segmentWriteKey },
          {
            initialPageview: true,
            user: {
              localStorage: {
                key: LOCAL_STORAGE_KEY,
              },
            },
          }
        )
        .then((instance) => {
          setAnalytics(instance[0])
        })
        .catch((e) =>
          console.error(`Could not connect to Segment. Error: ${e}`)
        )
        .finally(() => setLoaded(true))
    }
  }, [loaded, segmentWriteKey])

  const trackWithSegment = useCallback(
    async ({ event, options }: TrackedEvent) => {
      if (analytics) {
        void analytics.track(event, {
          ...options,
          uuid: analytics.user().anonymousId(),
        })
      } else {
        // push the event into the queue
        setQueue((prevQueue) => [
          ...prevQueue,
          {
            event,
            options,
            tracker: "segment",
          },
        ])
        console.warn(
          "Segment is either not installed or not configured. Simulating success..."
        )
      }
    },
    [analytics, loaded]
  )

  const trackWithPostHog = async ({ event, options }: TrackedEvent) => {
    posthog.capture(event, options)
  }

  const processEvent = useCallback(
    async (event: TrackedEvent) => {
      const trackers = Array.isArray(event.tracker)
        ? event.tracker
        : [event.tracker]
      await Promise.all(
        trackers.map(async (tracker) => {
          switch (tracker) {
            case "posthog":
              return trackWithPostHog(event)
            case "segment":
            default:
              return trackWithSegment(event)
          }
        })
      )
    },
    [trackWithSegment, trackWithPostHog]
  )

  const track = ({ event }: { event: TrackedEvent }) => {
    // Always queue events - this makes tracking non-blocking
    setQueue((prevQueue) => [...prevQueue, event])

    // Process event callback immediately
    // This ensures that the callback is called even if the event is queued
    event.callback?.()
  }

  useEffect(() => {
    initSegment()
  }, [initSegment])

  useEffect(() => {
    if (analytics && queue.length) {
      // Process queue in background without blocking
      const currentQueue = [...queue]
      setQueue([])

      // Process events asynchronously in batches to avoid overwhelming the system
      const batchSize = 5
      for (let i = 0; i < currentQueue.length; i += batchSize) {
        const batch = currentQueue.slice(i, i + batchSize)
        setTimeout(() => {
          batch.forEach(processEvent)
        }, i * 10) // Small delay between batches
      }
    }
  }, [analytics, queue, trackWithSegment, trackWithPostHog, processEvent])

  useEffect(() => {
    if (!reoDevKey) {
      return
    }

    loadReoScript({
      clientID: reoDevKey,
    })
      .then((Reo: unknown) => {
        ;(Reo as { init: (config: { clientID: string }) => void }).init({
          clientID: reoDevKey,
        })
      })
      .catch((e: Error) => {
        console.error(`Could not connect to Reodotdev. Error: ${e}`)
      })
  }, [reoDevKey])

  return (
    <AnalyticsContext.Provider
      value={{
        analytics,
        track,
        loaded,
      }}
    >
      {children}
    </AnalyticsContext.Provider>
  )
}

export const useAnalytics = () => {
  const context = useContext(AnalyticsContext)

  if (!context) {
    throw new Error("useAnalytics must be used within a AnalyticsProvider")
  }

  return context
}
