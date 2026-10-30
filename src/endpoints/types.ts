import { z } from "zod";

export const EndpointSchema = z.object({
  hostname: z.string(),
  port: z.number().int().min(1).max(65_535),
  url: z.url(),
});

export type Endpoint = z.infer<typeof EndpointSchema>;

export type Endpoints = Record<string, Endpoint>;

export type EndpointPorts = Record<string, Omit<Endpoint, "url">>;
