import type { Server } from "node:http";
import { loadTokenData } from "./auth.js";
import {
  CloudflareTunnel,
  localTunnelAddress,
} from "./cloudflare.js";
import {
  cursorBaseUrl,
  loadAppConfig,
  type AppConfig,
} from "./config.js";
import { formatCursorConfiguration } from "./cursor-output.js";
import { ChatGPTOAuthProvider } from "./provider.js";
import { createApp } from "./server.js";

export interface MainOptions {
  withTunnel?: boolean;
}

export async function main(options: MainOptions = {}): Promise<void> {
  const withTunnel = options.withTunnel !== false;
  const config = loadAppConfig({ requireTunnel: withTunnel });
  validateCodexAuth(config);

  console.log("\nCursor Luna Proxy\n");
  console.log("✓ Codex authentication available");

  const provider = new ChatGPTOAuthProvider({
    model: config.model,
    authJsonPath: config.authPath,
  });
  const app = createApp({
    provider,
    model: config.model,
    authPath: config.authPath,
    proxyApiKey: config.proxyApiKey,
  });
  const server = await listen(app, config);
  const localUrl = localTunnelAddress(config.host, config.port);
  await waitForHealth(`${localUrl}/health`);
  console.log(`✓ Local proxy listening on ${config.host}:${config.port}`);

  let tunnel: CloudflareTunnel | null = null;
  let stopping = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const closeServer = (): Promise<void> => closeHttpServer(server);

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const tunnelToStop = tunnel;
    const serverClose = closeServer();
    const stopPromise = tunnelToStop?.stop() ?? Promise.resolve();
    await stopPromise;
    await serverClose;
    resolveStopped();
  };
  const handleSignal = (): void => {
    console.log("\nStopping...");
    void shutdown();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    if (withTunnel) {
      tunnel = new CloudflareTunnel({ token: config.cloudflareTunnelToken as string });
      tunnel.onExit((exit) => {
        if (stopping) return;
        const exitCode = exit.code == null
          ? `signal ${exit.signal ?? "unknown"}`
          : String(exit.code);
        console.error(
          `\nCloudflare Tunnel exited unexpectedly.\n\nExit code: ${exitCode}\n\nThe local proxy is still available at:\n${localUrl}/v1`,
        );
        process.exitCode = 1;
        void shutdown();
      });
      tunnel.start();
      await tunnel.waitUntilConnected();
      console.log("✓ Cloudflare tunnel connected");
      await waitForHealth(`${config.publicUrl as string}/health`, {
        attempts: 60,
        delayMs: 500,
        label: "Public tunnel health",
      });
      if (!tunnel.isConnected) {
        throw new Error("Cloudflare Tunnel is no longer connected");
      }
    }

    const models = await queryModels(localUrl, config.proxyApiKey);
    if (stopping) throw new Error("Cloudflare Tunnel is no longer running");
    if (!models.includes("gpt-5.6-luna")) {
      throw new Error(
        "GPT-5.6 Luna is not available for the authenticated ChatGPT account.",
      );
    }
    console.log("✓ GPT-5.6 Luna available");
    const publicUrl = withTunnel
      ? cursorBaseUrl(config.publicUrl as string)
      : `${localUrl}/v1`;
    console.log(formatCursorConfiguration({
      baseUrl: publicUrl,
      apiKey: config.proxyApiKey,
      models: models.filter((model) => model === "gpt-5.6-luna"
        || model.startsWith("gpt-5.6-luna-")
        || model.startsWith("luna-")),
    }));
    await stopped;
  } catch (err) {
    if (stopping) return;
    await shutdown();
    throw err;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

function validateCodexAuth(config: AppConfig): void {
  try {
    loadTokenData(config.authPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/auth file not found/i.test(message)) {
      throw new Error("Codex authentication not found.\n\nRun:\n\n  codex login\n\nThen start the proxy again.");
    }
    throw new Error(`Codex authentication is invalid.\n\n${message}`);
  }
}

async function listen(
  app: ReturnType<typeof createApp>,
  config: AppConfig,
): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
    server.once("error", reject);
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForHealth(
  url: string,
  options: { attempts?: number; delayMs?: number; label?: string } = {},
): Promise<void> {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 250;
  const label = options.label ?? "Proxy";
  let lastError = "no response";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body = await response.json() as { status?: unknown };
        if (body.status === "ok") return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${label} health check failed at ${url}: ${lastError}`);
}

async function queryModels(baseUrl: string, proxyApiKey: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${proxyApiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Codex model catalog check failed: HTTP ${response.status}`);
  }
  const body = await response.json() as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("Codex model catalog response is invalid");
  return body.data
    .map((model) => typeof model === "object" && model !== null
      ? (model as Record<string, unknown>).id
      : undefined)
    .filter((id): id is string => typeof id === "string");
}
