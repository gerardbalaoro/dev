import { z } from "zod";

export const ProxyStateSchema = z.discriminatedUnion("provider", [
  z.object({
    data: z.object({
      admin: z.url(),
      origin: z.url(),
      server: z.string().min(1),
    }),
    provider: z.literal("caddy"),
  }),
  z.object({
    data: z.record(z.string().startsWith("PORTLESS_"), z.string()),
    provider: z.literal("portless"),
  }),
]);

export type ProxyState = z.infer<typeof ProxyStateSchema>;
export type CaddyState = Extract<ProxyState, { provider: "caddy" }>;
export type PortlessState = Extract<ProxyState, { provider: "portless" }>;

export const HostnameClaimSchema = z.object({
  hostname: z.string().min(1),
  owner: z.string().min(1),
  root: z.string().min(1),
});
export const RouteClaimSchema = HostnameClaimSchema.extend({
  port: z.number().int().min(1).max(65_535),
});
export type HostnameClaim = z.infer<typeof HostnameClaimSchema>;
export type RouteClaim = z.infer<typeof RouteClaimSchema>;

export interface Provider {
  id: string;
  isAvailable: () => Promise<boolean>;
  ensureReady: () => Promise<void>;
  getEndpointUrl: (hostname: string) => Promise<string>;
  publish: (claim: RouteClaim) => Promise<void>;
  unpublish: (claim: Pick<RouteClaim, "hostname" | "owner">) => Promise<void>;
  getState: () => ProxyState;
}
