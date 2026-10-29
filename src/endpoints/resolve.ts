import { ResolvedEndpointSchema } from "@/config/schema";
import type { EndpointConfig } from "@/config/types";
import { prefix, hostname } from "@/endpoints/hostname";
import type { Endpoints as ResolvedEndpoints, EndpointPorts } from "@/endpoints/types";
import type { Resolver } from "@/env/resolve";
import type { Provider } from "@/proxy/types";

async function ports(
  config: Record<string, EndpointConfig>,
  workspace: string,
  context: Resolver
): Promise<EndpointPorts> {
  const endpoints: EndpointPorts = {};
  await Array.fromAsync(Object.entries(config), async ([name, definition]) => {
    const expanded = ResolvedEndpointSchema.parse(definition);
    const port = Number(await context.resolveValue(expanded.port));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid port for endpoint ${name}: ${port}`);
    }
    endpoints[name] = {
      hostname: hostname(name, workspace, expanded.root),
      port,
    };
    context.set(`${prefix(name)}_PORT`, String(port));
  });
  return endpoints;
}

async function urls(
  resolved: EndpointPorts,
  provider: Provider,
  context: Resolver
): Promise<ResolvedEndpoints> {
  const endpoints: ResolvedEndpoints = {};
  await Array.fromAsync(Object.entries(resolved), async ([name, endpoint]) => {
    const url = await provider.getEndpointUrl(endpoint.hostname);
    endpoints[name] = { ...endpoint, url };
    context.set(`${prefix(name)}_URL`, url);
  });
  return endpoints;
}

export const Endpoints = { ports, urls };
