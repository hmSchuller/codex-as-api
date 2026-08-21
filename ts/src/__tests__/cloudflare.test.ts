import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  CloudflareTunnel,
  type SpawnCloudflared,
} from "../cloudflare.js";

class FakeCloudflared extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM") {
      setImmediate(() => this.emit("exit", 0, null));
    }
    return true;
  }
}

describe("Cloudflare named tunnel", () => {
  it("uses the named tunnel command and passes the token only in the environment", async () => {
    const child = new FakeCloudflared();
    let command = "";
    let args: readonly string[] = [];
    let spawnOptions: { env?: NodeJS.ProcessEnv } = {};
    const spawn: SpawnCloudflared = (receivedCommand, receivedArgs, options) => {
      command = receivedCommand;
      args = receivedArgs;
      spawnOptions = options;
      return child as never;
    };
    const tunnel = new CloudflareTunnel({
      token: "secret-cloudflare-token",
      locate: () => "/usr/local/bin/cloudflared",
      spawn,
      startupTimeoutMs: 500,
    });

    tunnel.start();
    child.stdout.write("INF Registered tunnel connection connIndex=0\n");
    await tunnel.waitUntilConnected();

    assert.equal(command, "/usr/local/bin/cloudflared");
    assert.deepEqual(args, ["tunnel", "--no-autoupdate", "run"]);
    assert.equal(args.includes("secret-cloudflare-token"), false);
    assert.equal(spawnOptions.env?.TUNNEL_TOKEN, "secret-cloudflare-token");
    assert.equal(tunnel.isConnected, true);

    await tunnel.stop();
    assert.deepEqual(child.signals, ["SIGTERM"]);
    assert.equal(tunnel.isRunning, false);
  });

  it("reports an unexpected tunnel exit", async () => {
    const child = new FakeCloudflared();
    const tunnel = new CloudflareTunnel({
      token: "secret-cloudflare-token",
      locate: () => "/usr/local/bin/cloudflared",
      spawn: (() => child as never) as SpawnCloudflared,
      startupTimeoutMs: 500,
    });
    tunnel.start();
    const exit = new Promise<{ code: number | null }>((resolve) => {
      tunnel.onExit((value) => resolve({ code: value.code }));
    });
    child.emit("exit", 1, null);
    assert.equal((await exit).code, 1);
    await assert.rejects(tunnel.waitUntilConnected(), /exited unexpectedly/);
  });
});
