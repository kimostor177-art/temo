"use client"

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"
import { Analytics, AnalyticsBrowser } from "@segment/analytics-next"
import { PostHogProvider as PHProvider } from "posthog-js/react"
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
  track: (
    event: string,
    options?: Record<string, any>,
    callback?: () => void
  ) => void
}

export type TrackedEvent = {
  event: string
  options?: Record<string, any>
}

const AnalyticsContext = createContext<AnalyticsContextType | null>(null)

export type AnalyticsProviderProps = {
  segmentWriteKey?: string
  reoDevKey?: string
  postHogKey?: string
  postHogApiHost?: string
  children?: React.ReactNode
}

const LOCAL_STORAGE_KEY = "ajs_anonymous_id"

export const AnalyticsProvider = ({
  segmentWriteKey = "temp",
  reoDevKey,
  children,
  postHogKey,
  postHogApiHost = "https://eu.i.posthog.com",
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

  const track = useCallback(
    async (
      event: string,
      options?: Record<string, any>,
      callback?: () => void
    ) => {
      if (analytics) {
        void analytics.track(
          event,
          {
            ...options,
            uuid: analytics.user().anonymousId(),
          },
          callback
        )
      } else {
        // push the event into the queue
        setQueue((prevQueue) => [
          ...prevQueue,
          {
            event,
            options,
          },
        ])
        if (callback) {
          console.warn(
            "Segment is either not installed or not configured. Simulating success..."
          )
          callback()
        }
      }
    },
    [analytics, loaded]
  )

  const initPostHog = useCallback(() => {
    if (!postHogKey) {
      return
    }

    posthog.init(postHogKey, {
      api_host: postHogApiHost,
      person_profiles: "always",
      defaults: "2025-05-24",
    })
  }, [])

  useEffect(() => {
    initSegment()
    initPostHog()
  }, [initSegment])

  useEffect(() => {
    if (analytics && queue.length) {
      // track stuff in queue
      queue.forEach(async (trackEvent) =>
        track(trackEvent.event, trackEvent.options)
      )
      setQueue([])
    }
  }, [analytics, queue])

  useEffect(() => {
    if (!reoDevKey) {
      return
    }

    loadReoScript({
      clientID: reoDevKey,
    })
      .then((Reo: any) => {
        Reo.init({
          clientID: reoDevKey,
        })
      })
      .catch((e: any) => {
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
      {postHogKey ? (
        <PHProvider client={posthog}>{children}</PHProvider>
      ) : (
        children
      )}
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
