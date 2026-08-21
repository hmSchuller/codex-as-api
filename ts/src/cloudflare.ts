import * as childProcess from "node:child_process";
import type { Readable } from "node:stream";

const TUNNEL_ARGS = ["tunnel", "--no-autoupdate", "run"];
const STARTUP_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;

type SpawnedProcess = childProcess.ChildProcess & {
  stdout: Readable | null;
  stderr: Readable | null;
};

export type SpawnCloudflared = (
  command: string,
  args: readonly string[],
  options: childProcess.SpawnOptions,
) => SpawnedProcess;

export interface CloudflareTunnelOptions {
  token: string;
  executable?: string;
  locate?: () => string | null;
  spawn?: SpawnCloudflared;
  startupTimeoutMs?: number;
}

export interface CloudflareExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function findCloudflared(): string | null {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const output = childProcess.execFileSync(command, ["cloudflared"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const executable = output.trim().split(/\r?\n/)[0];
    return executable || null;
  } catch {
    return null;
  }
}

export function cloudflaredInstallInstruction(): string {
  if (process.platform === "darwin") return "brew install cloudflared";
  if (process.platform === "linux") {
    return "Install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
  }
  if (process.platform === "win32") return "winget install Cloudflare.cloudflared";
  return "Install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
}

export class CloudflareTunnel {
  private readonly token: string;
  private readonly executableOverride?: string;
  private readonly locate: () => string | null;
  private readonly spawn: SpawnCloudflared;
  private readonly startupTimeoutMs: number;
  private child: SpawnedProcess | null = null;
  private connected = false;
  private output = "";
  private connectionResolve: (() => void) | null = null;
  private connectionReject: ((error: Error) => void) | null = null;
  private connectionPromise: Promise<void> | null = null;
  private exitPromise: Promise<CloudflareExit> | null = null;
  private exitResolve: ((exit: CloudflareExit) => void) | null = null;
  private exitInfo: CloudflareExit | null = null;
  private readonly exitListeners = new Set<(exit: CloudflareExit) => void>();
  private readonly connectionListeners = new Set<() => void>();

  constructor(options: CloudflareTunnelOptions) {
    if (!options.token.trim()) throw new Error("CLOUDFLARE_TUNNEL_TOKEN must not be empty");
    this.token = options.token.trim();
    this.executableOverride = options.executable;
    this.locate = options.locate ?? findCloudflared;
    this.spawn = options.spawn ?? ((command, args, spawnOptions) =>
      childProcess.spawn(command, [...args], spawnOptions) as SpawnedProcess);
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  }

  get isRunning(): boolean {
    return this.child != null && this.exitInfo == null;
  }

  get isConnected(): boolean {
    return this.connected && this.isRunning;
  }

  get recentOutput(): string {
    return this.output;
  }

  onExit(listener: (exit: CloudflareExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onConnected(listener: () => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  start(): void {
    if (this.child != null) throw new Error("cloudflared is already running");
    const executable = this.executableOverride ?? this.locate();
    if (!executable) {
      throw new Error(
        `cloudflared was not found on PATH.\n\nInstall it, then run:\n\n  npm start\n\n${cloudflaredInstallInstruction()}`,
      );
    }

    const environment: NodeJS.ProcessEnv = { ...process.env, TUNNEL_TOKEN: this.token };
    delete environment.CLOUDFLARE_TUNNEL_TOKEN;
    const child = this.spawn(executable, TUNNEL_ARGS, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.exitPromise = new Promise<CloudflareExit>((resolve) => {
      this.exitResolve = resolve;
    });
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.connectionResolve = resolve;
      this.connectionReject = reject;
    });
    child.stdout?.on("data", (chunk: Buffer | string) => this.handleOutput(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => this.handleOutput(String(chunk)));
    child.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.rejectConnection(new Error(`cloudflared failed to start: ${message}`));
    });
    child.once("exit", (code, signal) => {
      const exit = { code, signal };
      this.exitInfo = exit;
      this.exitResolve?.(exit);
      this.exitResolve = null;
      if (!this.connected) {
        this.rejectConnection(new Error(formatTunnelExit(exit, this.output)));
      }
      for (const listener of this.exitListeners) listener(exit);
    });
  }

  async waitUntilConnected(): Promise<void> {
    if (this.connectionPromise == null) {
      throw new Error("cloudflared has not been started");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `cloudflared did not report a registered tunnel connection within ${this.startupTimeoutMs / 1000} seconds${this.output ? `:\n${this.output}` : ""}`,
        ));
      }, this.startupTimeoutMs);
      this.connectionPromise?.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child == null || this.exitInfo != null) return;
    child.kill("SIGTERM");
    const exitPromise = this.exitPromise;
    if (exitPromise == null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.exitInfo == null) child.kill("SIGKILL");
        resolve();
      }, STOP_TIMEOUT_MS);
      exitPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private handleOutput(chunk: string): void {
    const safeChunk = chunk.replaceAll(this.token, "***");
    this.output = `${this.output}${safeChunk}`.slice(-4_000);
    if (/registered tunnel connection|tunnel connected|connection registered/i.test(safeChunk)) {
      if (!this.connected) {
        this.connected = true;
        this.connectionResolve?.();
        this.connectionResolve = null;
        this.connectionReject = null;
        for (const listener of this.connectionListeners) listener();
      }
    }
    if (/invalid.*token|token.*invalid|login required|tunnel .*not found|failed to start/i.test(safeChunk)) {
      this.rejectConnection(new Error(`cloudflared startup failed: ${safeChunk.trim()}`));
    }
  }

  private rejectConnection(error: Error): void {
    this.connectionReject?.(error);
    this.connectionResolve = null;
    this.connectionReject = null;
  }
}

function formatTunnelExit(exit: CloudflareExit, output: string): string {
  const status = exit.code == null
    ? `signal ${exit.signal ?? "unknown"}`
    : `code ${exit.code}`;
  return `Cloudflare Tunnel exited unexpectedly.\n\nExit ${status}.${output ? `\n\n${output}` : ""}`;
}

export function localTunnelAddress(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}`;
}
