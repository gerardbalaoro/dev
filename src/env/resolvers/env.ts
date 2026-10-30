export function read(name: string, env: Record<string, string>): string {
  const value = env[name];

  if (!Object.hasOwn(env, name) || value === undefined) {
    throw new Error(
      `Environment variable ${name} is not resolved; references must point to earlier values`
    );
  }

  return value;
}
