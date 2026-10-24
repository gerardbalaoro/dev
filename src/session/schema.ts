import { z } from "zod";

import { EndpointSchema } from "@/endpoints/types";
import { IdentitySchema } from "@/process/identity";
import { ProxyStateSchema, HostnameClaimSchema } from "@/proxy/types";

export const SessionSchema = z
  .object({
    commands: z.array(IdentitySchema).optional(),
    endpoints: z.record(z.string(), EndpointSchema),
    env: z.record(z.string(), z.string()),
    id: z.string(),
    ownerStartToken: z.string().optional(),
    pendingRoutes: z.array(HostnameClaimSchema).default([]),
    pid: z.number().int().positive(),
    process: IdentitySchema.optional(),
    proxy: ProxyStateSchema.optional(),
    root: z.string(),
    shutdown: z.string().optional(),
    startedAt: z.string(),
    status: z.enum(["starting", "running", "stopping"]),
    version: z.literal(1),
    workspace: z.string(),
  })
  .superRefine((session, context) => {
    if (
      !session.proxy &&
      session.status === "running" &&
      Object.keys(session.endpoints).length
    ) {
      context.addIssue({
        code: "custom",
        message: "Routed sessions require proxy recovery state",
        path: ["proxy"],
      });
    }
    for (const claim of session.pendingRoutes) {
      if (claim.owner !== session.id || claim.root !== session.root) {
        context.addIssue({
          code: "custom",
          message: "Route claim does not belong to this session",
          path: ["pendingRoutes"],
        });
      }
    }
  });
