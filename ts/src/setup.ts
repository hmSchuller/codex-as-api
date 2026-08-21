import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  cloudflaredInstallInstruction,
  findCloudflared,
} from "./cloudflare.js";
import {
  cursorBaseUrl,
  defaultEnvFilePath,
  generateProxyApiKey,
  loadAppConfig,
  loadDotEnv,
  normalizePublicUrl,
  readDotEnv,
  writeMissingDotEnvValues,
} from "./config.js";
import { formatCursorConfiguration } from "./cursor-output.js";
import { loadTokenData } from "./auth.js";

const DEFAULT_LUNA_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-luna-low",
  "gpt-5.6-luna-medium",
  "gpt-5.6-luna-high",
  "gpt-5.6-luna-xhigh",
  "gpt-5.6-luna-max",
  "luna-low",
  "luna-low-fast",
  "luna-medium-fast",
  "luna-high-fast",
  "luna-xhigh-fast",
  "luna-max-fast",
];

export async function runSetup(): Promise<void> {
  assertNodeVersion();
  const envFilePath = defaultEnvFilePath();
  loadDotEnv(envFilePath);
  const stored = readDotEnv(envFilePath);
  const value = (name: string): string | undefined =>
    stored[name]?.trim() || process.env[name]?.trim() || undefined;

  const proxyApiKey = value("PROXY_API_KEY") || generateProxyApiKey();
  let tunnelToken = value("CLOUDFLARE_TUNNEL_TOKEN");
  let publicUrl = value("PUBLIC_URL");
  const prompts = readline.createInterface({ input, output });
  try {
    if (!tunnelToken) {
      tunnelToken = await prompts.question("Cloudflare tunnel token: ");
      if (!tunnelToken.trim()) {
        throw new Error("A Cloudflare tunnel token is required. Run npm run setup again.");
      }
    }
    if (!publicUrl) {
      publicUrl = await prompts.question("Public URL or hostname (for example https://luna.example.com): ");
      if (!publicUrl.trim()) {
        throw new Error("A public URL is required. Run npm run setup again.");
      }
    }
  } finally {
    prompts.close();
  }

  const normalizedPublicUrl = normalizePublicUrl(publicUrl);
  writeMissingDotEnvValues(envFilePath, {
    PORT: value("PORT") || "8787",
    PROXY_API_KEY: proxyApiKey,
    CLOUDFLARE_TUNNEL_TOKEN: tunnelToken,
    PUBLIC_URL: normalizedPublicUrl,
  });

  console.log(`\nConfiguration saved to ${envFilePath}`);
  const cloudflared = findCloudflared();
  if (cloudflared) {
    console.log("✓ cloudflared available");
  } else {
    console.log(
      `! cloudflared was not found on PATH. Install it with:\n\n  ${cloudflaredInstallInstruction()}`,
    );
  }

  try {
    loadTokenData(process.env.CODEX_AS_API_AUTH_PATH);
    console.log("✓ Codex authentication available");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      `! Codex authentication not found. Run:\n\n  codex login\n\n${message}`,
    );
  }

  console.log(formatCursorConfiguration({
    baseUrl: cursorBaseUrl(normalizedPublicUrl),
    apiKey: proxyApiKey,
    models: DEFAULT_LUNA_MODELS,
    revealApiKey: true,
  }));
  console.log("\nStart the proxy with:\n\n  npm start\n");
}

export function printConfig(): void {
  const config = loadAppConfig({ requireTunnel: false });
  const baseUrl = config.publicUrl == null
    ? `http://127.0.0.1:${config.port}/v1`
    : cursorBaseUrl(config.publicUrl);
  console.log(formatCursorConfiguration({
    baseUrl,
    apiKey: config.proxyApiKey,
    models: DEFAULT_LUNA_MODELS,
    revealApiKey: true,
  }));
}

function assertNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(major) || major < 18) {
    throw new Error(`Node.js 18 or newer is required (found ${process.versions.node})`);
  }
}

if (process.argv.includes("--config")) {
  try {
    printConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
} else {
  try {
    await runSetup();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
