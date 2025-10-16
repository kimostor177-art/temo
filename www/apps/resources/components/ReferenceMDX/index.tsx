"use client"

import { MDXClientLazy, SerializeResult } from "next-mdx-remote-client/csr"
import MDXComponents from "../MDXComponents"
import { Loading, swrFetcher } from "docs-ui"
import useSWR from "swr"
import { config } from "../../config"
import { notFound } from "next/navigation"

type ReferenceMDXProps = {
  slug: string[]
}

export const ReferenceMDX = ({ slug }: ReferenceMDXProps) => {
  const {
    data: serializedResult,
    error,
    isLoading,
  } = useSWR<SerializeResult | { error: { name: string; message: string } }>(
    `${config.basePath}/api/references/${slug.join("/")}`,
    swrFetcher
  )

  if (isLoading || !serializedResult) {
    return <Loading />
  }

  if ("error" in serializedResult || error) {
    return notFound()
  }

  return <MDXClientLazy {...serializedResult} components={MDXComponents} />
}
