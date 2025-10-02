import { VIRTUAL_MODULES } from "@medusajs/admin-shared"
import path from "path"
import type { HmrOptions, InlineConfig } from "vite"
import { injectTailwindCSS } from "../plugins/inject-tailwindcss"
import { writeStaticFiles } from "../plugins/write-static-files"
import { BundlerOptions } from "../types"

export async function getViteConfig(
  options: BundlerOptions
): Promise<InlineConfig> {
  const { searchForWorkspaceRoot, mergeConfig } = await import("vite")
  const { default: react } = await import("@vitejs/plugin-react")
  const { default: medusa } = await import("@medusajs/admin-vite-plugin")

  const getPort = await import("get-port")
  const hmrPort = process.env.HMR_PORT
    ? parseInt(process.env.HMR_PORT)
    : await getPort.default()
  const hmrOptions = getHmrConfig(hmrPort)

  const root = path.resolve(process.cwd(), ".medusa/client")

  const backendUrl = options.backendUrl ?? ""
  const storefrontUrl = options.storefrontUrl ?? ""

  const baseConfig: InlineConfig = {
    root,
    base: options.path,
    build: {
      emptyOutDir: true,
      outDir: path.resolve(process.cwd(), options.outDir),
    },
    optimizeDeps: {
      include: [
        "react",
        "react/jsx-runtime",
        "react-dom/client",
        "react-router-dom",
        "@medusajs/ui",
        "@medusajs/dashboard",
        "@medusajs/js-sdk",
        "@tanstack/react-query",
      ],
      exclude: [...VIRTUAL_MODULES],
    },
    define: {
      __BASE__: JSON.stringify(options.path),
      __BACKEND_URL__: JSON.stringify(backendUrl),
      __STOREFRONT_URL__: JSON.stringify(storefrontUrl),
    },
    server: {
      fs: {
        allow: [searchForWorkspaceRoot(process.cwd())],
      },
      hmr: hmrOptions,
    },
    plugins: [
      writeStaticFiles({
        plugins: options.plugins,
      }),
      injectTailwindCSS({
        entry: root,
        sources: options.sources,
        plugins: options.plugins,
      }),
      react(),
      medusa({
        sources: options.sources,
      }),
    ],
  }

  // Inject plugin environment variables with vite define
  const pluginEnv: Record<string, string | undefined> = { BACKEND_URL: backendUrl }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("PLUGIN_")) {
      pluginEnv[key.replace(/^PLUGIN_/, "")] = value
    }
  }
  baseConfig.define!["process.env"] = JSON.stringify(pluginEnv)

  if (options.vite) {
    const customConfig = options.vite(baseConfig)
    return mergeConfig(baseConfig, customConfig)
  }

  return baseConfig
}

function getHmrConfig(hmrPort: number): HmrOptions | boolean {
  const options: HmrOptions = {
    port: hmrPort,
  }

  if (process.env.HMR_PROTOCOL) {
    options.protocol = process.env.HMR_PROTOCOL
  }
  if (process.env.HMR_HOST) {
    options.host = process.env.HMR_HOST
  }
  if (process.env.HMR_CLIENT_PORT) {
    options.clientPort = parseInt(process.env.HMR_CLIENT_PORT)
  }

  return options
}
