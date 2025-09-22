import { logger } from "@medusajs/framework"
import type { Logger } from "@medusajs/framework/types"
import {
  defineMikroOrmCliConfig,
  DmlEntity,
  dynamicImport,
  isFileSkipped,
  toUnixSlash,
} from "@medusajs/framework/utils"
import { MetadataStorage } from "@medusajs/framework/mikro-orm/core"
import { MikroORM } from "@medusajs/framework/mikro-orm/postgresql"
import { glob } from "glob"
import { dirname, join } from "path"

const TERMINAL_SIZE = process.stdout.columns

/**
 * Generate migrations for all scanned modules in a plugin
 */
const main = async function ({ directory }) {
  try {
    const moduleDescriptors = [] as {
      serviceName: string
      migrationsPath: string
      entities: any[]
    }[]

    const modulePaths = glob.sync(
      toUnixSlash(join(directory, "src", "modules", "*", "index.ts"))
    )

    for (const path of modulePaths) {
      const moduleDirname = dirname(path)
      const serviceName = await getModuleServiceName(path)
      const entities = await getEntitiesForModule(moduleDirname)

      moduleDescriptors.push({
        serviceName,
        migrationsPath: join(moduleDirname, "migrations"),
        entities,
      })
    }

    /**
     * Generating migrations
     */
    logger.info("Generating migrations...")

    await generateMigrations(moduleDescriptors, logger)

    logger.log(new Array(TERMINAL_SIZE).join("-"))
    logger.info("Migrations generated")

    process.exit()
  } catch (error) {
    logger.log(new Array(TERMINAL_SIZE).join("-"))

    logger.error(error.message, error)
    process.exit(1)
  }
}

async function getEntitiesForModule(path: string) {
  const entities = [] as any[]

  const entityPaths = glob.sync(toUnixSlash(join(path, "models", "*.ts")), {
    ignore: ["**/index.{js,ts}", "**/*.d.ts"],
  })

  for (const entityPath of entityPaths) {
    const entityExports = await dynamicImport(entityPath)
    if (isFileSkipped(entityExports)) {
      continue
    }

    const validEntities = Object.values(entityExports).filter(
      (potentialEntity) => {
        return (
          DmlEntity.isDmlEntity(potentialEntity) ||
          !!MetadataStorage.getMetadataFromDecorator(potentialEntity as any)
        )
      }
    )
    entities.push(...validEntities)
  }

  return entities
}

async function getModuleServiceName(path: string) {
  const moduleExport = await dynamicImport(path)
  if (!moduleExport.default) {
    throw new Error("The module should default export the `Module()`")
  }
  return (moduleExport.default.service as any).prototype.__joinerConfig()
    .serviceName
}

async function generateMigrations(
  moduleDescriptors: {
    serviceName: string
    migrationsPath: string
    entities: any[]
  }[] = [],
  logger: Logger
) {
  const DB_HOST = process.env.DB_HOST ?? "localhost"
  const DB_USERNAME = process.env.DB_USERNAME ?? ""
  const DB_PASSWORD = process.env.DB_PASSWORD ?? ""
  const DB_PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432
  const DATABASE_URL = process.env.DATABASE_URL

  for (const moduleDescriptor of moduleDescriptors) {
    logger.info(
      `Generating migrations for module ${moduleDescriptor.serviceName}...`
    )

    const mikroOrmConfig = defineMikroOrmCliConfig(
      moduleDescriptor.serviceName,
      {
        entities: moduleDescriptor.entities,
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USERNAME,
        password: DB_PASSWORD,
        ...(DATABASE_URL ? { clientUrl: DATABASE_URL } : {}),
        migrations: {
          path: moduleDescriptor.migrationsPath,
        },
      }
    )

    const orm = await MikroORM.init(mikroOrmConfig)
    const migrator = orm.getMigrator()
    const result = await migrator.createMigration()

    if (result.fileName) {
      logger.info(`Migration created: ${result.fileName}`)
    } else {
      logger.info(`No migration created`)
    }
  }
}

export default main
