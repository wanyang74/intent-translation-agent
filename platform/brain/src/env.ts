// Local settings for development: KEY=value lines from a file such as .env.local (git-ignored), for values the
// environment doesn't already set. Values are never printed.
import { existsSync, readFileSync } from 'node:fs';

export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) value = value.slice(1, -1);
    if (value) out[key] = value;
  }
  return out;
}

/** The environment's value, or the file's, or undefined. */
export function setting(name: string, file: string): string | undefined {
  return process.env[name] || readEnvFile(file)[name];
}
