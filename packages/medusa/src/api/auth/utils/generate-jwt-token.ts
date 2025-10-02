import {
  AuthIdentityDTO,
  ProjectConfigOptions,
} from "@medusajs/framework/types"
import { generateJwtToken } from "@medusajs/framework/utils"
import { type Secret } from "jsonwebtoken"

export function generateJwtTokenForAuthIdentity(
  {
    authIdentity,
    actorType,
    authProvider,
  }: {
    authIdentity: AuthIdentityDTO
    actorType: string
    authProvider?: string
  },
  {
    secret,
    expiresIn,
    options,
  }: {
    secret: Secret
    expiresIn: string | undefined
    options?: ProjectConfigOptions["http"]["jwtOptions"]
  }
) {
  const expiresIn_ = expiresIn ?? options?.expiresIn
  const entityIdKey = `${actorType}_id`
  const entityId = authIdentity?.app_metadata?.[entityIdKey] as
    | string
    | undefined

  const providerIdentity = !authProvider
    ? undefined
    : authIdentity.provider_identities?.filter(
        (identity) => identity.provider === authProvider
      )[0]

  return generateJwtToken(
    {
      actor_id: entityId ?? "",
      actor_type: actorType,
      auth_identity_id: authIdentity?.id ?? "",
      app_metadata: {
        [entityIdKey]: entityId,
      },
      user_metadata: providerIdentity?.user_metadata ?? {},
    },
    {
      secret,
      expiresIn: expiresIn_,
      jwtOptions: options,
    }
  )
}
