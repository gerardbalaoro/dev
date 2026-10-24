import type { z } from "zod";

import type { ConfigSchema, EndpointConfigSchema } from "@/config/schema";

export type Config = z.infer<typeof ConfigSchema>;
export type Extension = Partial<z.input<typeof ConfigSchema>>;
export type EndpointConfig = z.infer<typeof EndpointConfigSchema>;
