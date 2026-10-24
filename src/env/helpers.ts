import { NameSchema, ServiceSchema, PortSchema } from "@/env/schema";

function free(): string {
  return `\${port()}`;
}

function get(name: string): string {
  return `\${env(${JSON.stringify(NameSchema.parse(name))})}`;
}

function published(service: string, number: number): string {
  return `\${docker.compose.port(${JSON.stringify(ServiceSchema.parse(service))}, ${PortSchema.parse(number)})}`;
}

// Lowercase exports are the public fluent API's intentional naming convention.
export const port = { free };
export const env = { get };
export const docker = { port: published };
