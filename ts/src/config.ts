import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAuthPath } from "./auth.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_MODEL = "gpt-5.6-luna";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface AppConfig {
  envFilePath: string;
  host: string;
  port: number;
  proxyApiKey: string;
  cloudflareTunnelToken?: string;
  publicUrl?: string;
  authPath: string;
  model: string;
}

export interface LoadConfigOptions {
  envFilePath?: string;
  requireTunnel?: boolean;
}

export function defaultEnvFilePath(): string {
  return path.resolve(
    process.env.CODEX_AS_API_ENV_FILE?.trim() || path.join(process.cwd(), ".env"),
  );
}

export function readDotEnv(filePath = defaultEnvFilePath()): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err: unknown) {
    if (isErrno(err, "ENOENT")) return {};
    throw err;
  }

  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    values[name] = parseDotEnvValue(trimmed.slice(separator + 1).trim());
  }
  return values;
}

export function loadDotEnv(filePath = defaultEnvFilePath()): string {
  const resolvedPath = path.resolve(filePath);
  for (const [name, value] of Object.entries(readDotEnv(resolvedPath))) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  return resolvedPath;
}

export function writeMissingDotEnvValues(
  filePath: string,
  values: Record<string, string>,
): void {
  const resolvedPath = path.resolve(filePath);
  let content = "";
  try {
    content = fs.readFileSync(resolvedPath, "utf8");
  } catch (err: unknown) {
    if (!isErrno(err, "ENOENT")) throw err;
  }

  const lines = content.split(/\r?\n/);
  const present = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(lines[index]);
    if (!match) continue;
    const name = match[1];
    if (!(name in values)) continue;
    if (match[2] !== "") {
      present.add(name);
      continue;
    }
    lines[index] = `${name}=${formatDotEnvValue(values[name])}`;
    present.add(name);
  }

  const additions = Object.entries(values)
    .filter(([name]) => !present.has(name))
    .map(([name, value]) => `${name}=${formatDotEnvValue(value)}`);
  if (additions.length > 0) {
    const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    content = `${lines.join("\n")}${prefix}${additions.join("\n")}\n`;
  } else {
    content = lines.join("\n");
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(resolvedPath, 0o600);
  } catch {
    // Windows does not expose Unix file modes consistently.
  }
}

export function generateProxyApiKey(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function normalizePublicUrl(raw: string): string {
  const input = raw.trim();
  if (!input) throw new ConfigError("PUBLIC_URL must not be empty");
  const value = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(input)
    ? input
    : `https://${input}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError("PUBLIC_URL must be a valid HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("PUBLIC_URL must use http:// or https://");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigError("PUBLIC_URL must contain only a hostname and optional /v1 path");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname !== "" && pathname !== "/v1") {
    throw new ConfigError("PUBLIC_URL must contain only a hostname and optional /v1 path");
  }
  return `${parsed.origin}`;
}

export function cursorBaseUrl(publicUrl: string): string {
  return `${normalizePublicUrl(publicUrl)}/v1`;
}

export function loadAppConfig(options: LoadConfigOptions = {}): AppConfig {
  const envFilePath = loadDotEnv(options.envFilePath);
  const host = process.env.HOST?.trim()
    || process.env.CODEX_AS_API_HOST?.trim()
    || DEFAULT_HOST;
  const port = parsePort(process.env.PORT || process.env.CODEX_AS_API_PORT);
  const proxyApiKey = process.env.PROXY_API_KEY?.trim();
  if (!proxyApiKey) {
    throw new ConfigError(
      `PROXY_API_KEY is missing. Run:\n\n  npm run setup\n`,
    );
  }

  const requireTunnel = options.requireTunnel !== false;
  const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim() || undefined;
  const rawPublicUrl = process.env.PUBLIC_URL?.trim() || undefined;
  if (requireTunnel && !tunnelToken) {
    throw new ConfigError(
      "Cloudflare tunnel is not configured.\n\nRun:\n\n  npm run setup",
    );
  }
  if (requireTunnel && !rawPublicUrl) {
    throw new ConfigError(
      "PUBLIC_URL is missing.\n\nRun:\n\n  npm run setup",
    );
  }

  return {
    envFilePath,
    host,
    port,
    proxyApiKey,
    cloudflareTunnelToken: tunnelToken,
    publicUrl: rawPublicUrl == null ? undefined : normalizePublicUrl(rawPublicUrl),
    authPath: resolveAuthPath(process.env.CODEX_AS_API_AUTH_PATH),
    model: process.env.CODEX_AS_API_MODEL?.trim() || DEFAULT_MODEL,
  };
}

function parsePort(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseDotEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function formatDotEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error
    && "code" in err
    && (err as NodeJS.ErrnoException).code === code;
}
