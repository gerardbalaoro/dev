import { inherit } from "@/env/resolve";
import { Caddy } from "@/proxy/caddy";
import { Portless } from "@/proxy/portless";
import type { Provider, ProxyState } from "@/proxy/types";

interface DetectOptions {
  applicationPorts?: number[];
  signal?: AbortSignal;
  providers?: Provider[];
  env?: Record<string, string>;
}

export async function detect(
  cwd: string,
  { signal, providers, env = inherit(), applicationPorts = [] }: DetectOptions = {}
): Promise<Provider> {
  const candidates = providers ?? [
    new Portless(cwd, { applicationPorts, env, signal }),
    new Caddy({ applicationPorts, env, signal }),
  ];
  const failures: string[] = [];
  const select = async (index: number): Promise<Provider> => {
    const provider = candidates[index];
    if (!provider) {
      signal?.throwIfAborted();
      throw new Error(
        `No supported local proxy is available.\nInstall Portless or Caddy; dev start handles proxy setup automatically.\nSetup: https://github.com/gerardbalaoro/dev/blob/main/docs/proxies.md\n${failures.join("\n")}`
      );
    }
    signal?.throwIfAborted();
    try {
      if (await provider.isAvailable()) {
        await provider.ensureReady();
        return provider;
      }
      failures.push(`${provider.id}: unavailable`);
    } catch (error) {
      failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return select(index + 1);
  };
  return await select(0);
}

export function restore(state: ProxyState, cwd: string, env?: Record<string, string>): Provider {
  if (state.provider === "portless") {
    return new Portless(cwd, { env, state });
  }
  if (state.provider === "caddy") {
    return new Caddy({ state });
  }
  throw new Error("Unknown session proxy");
}
