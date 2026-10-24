import { z } from "zod";

import { prefix } from "@/endpoints/hostname";

const LabelSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u,
    "Use lowercase DNS labels starting with a letter"
  );
const ExpressionSchema = z.string().min(1);
const EndpointOptionsSchema = z
  .object({ port: ExpressionSchema, root: z.boolean().optional() })
  .strict();
export const EndpointConfigSchema = z.union([
  ExpressionSchema,
  EndpointOptionsSchema,
]);
export const ResolvedEndpointSchema = z.union([
  z.string().transform((port) => ({ port, root: undefined })),
  EndpointOptionsSchema,
]);

export const ConfigSchema = z
  .object({
    endpoints: z.record(LabelSchema.max(63), EndpointConfigSchema).default({}),
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string())
      .default({}),
    hooks: z
      .object({
        bootstrap: ExpressionSchema.optional(),
        shutdown: ExpressionSchema.optional(),
      })
      .strict()
      .default({}),
    // Leave room for the worktree suffix within a DNS label.
    name: LabelSchema.max(54),
    run: ExpressionSchema,
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      Object.values(config.endpoints).filter(
        (e) => ResolvedEndpointSchema.parse(e).root
      ).length > 1
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Only one root endpoint is allowed",
        path: ["endpoints"],
      });
    }
    const reserved = new Set(["WORKSPACE_NAME", "COMPOSE_PROJECT_NAME"]);
    for (const name of Object.keys(config.endpoints)) {
      reserved.add(`${prefix(name)}_PORT`);
      reserved.add(`${prefix(name)}_URL`);
    }
    for (const key of Object.keys(config.env)) {
      if (reserved.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `${key} is generated and cannot be overridden`,
          path: ["env", key],
        });
      }
    }
  });
