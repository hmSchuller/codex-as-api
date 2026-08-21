import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateProxyApiKey,
  loadAppConfig,
  loadDotEnv,
  normalizePublicUrl,
  writeMissingDotEnvValues,
} from "../config.js";

function withEnvironment(
  values: Record<string, string | undefined>,
  fn: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    fn();
  } finally {
    for (const [name, value] of previous) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("configuration", () => {
  it("normalizes public URLs and avoids a duplicated v1 path", () => {
    assert.equal(normalizePublicUrl("https://luna.example.com/"), "https://luna.example.com");
    assert.equal(normalizePublicUrl("https://luna.example.com/v1/"), "https://luna.example.com");
    assert.equal(normalizePublicUrl("luna.example.com"), "https://luna.example.com");
    assert.throws(() => normalizePublicUrl("https://luna.example.com/api"), /hostname and optional \/v1/);
  });

  it("rejects missing required startup settings", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-test-"));
    try {
      withEnvironment({
        PROXY_API_KEY: undefined,
        CLOUDFLARE_TUNNEL_TOKEN: undefined,
        PUBLIC_URL: undefined,
        CODEX_AS_API_ENV_FILE: path.join(directory, ".env"),
      }, () => {
        assert.throws(
          () => loadAppConfig({ envFilePath: path.join(directory, ".env") }),
          /PROXY_API_KEY is missing/,
        );
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("generates a cryptographically strong proxy key", () => {
    const first = generateProxyApiKey();
    const second = generateProxyApiKey();
    assert.ok(first.length >= 43);
    assert.notEqual(first, second);
    assert.match(first, /^[A-Za-z0-9_-]+$/);
  });

  it("preserves existing valid values while adding missing config", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-test-"));
    const envPath = path.join(directory, ".env");
    try {
      fs.writeFileSync(envPath, "PROXY_API_KEY=existing-secret\nPUBLIC_URL=https://old.example.com\n");
      writeMissingDotEnvValues(envPath, {
        PROXY_API_KEY: "new-secret",
        PUBLIC_URL: "https://new.example.com",
        CLOUDFLARE_TUNNEL_TOKEN: "tunnel-token",
      });
      const content = fs.readFileSync(envPath, "utf8");
      assert.match(content, /^PROXY_API_KEY=existing-secret$/m);
      assert.match(content, /^PUBLIC_URL=https:\/\/old\.example\.com$/m);
      assert.match(content, /^CLOUDFLARE_TUNNEL_TOKEN=tunnel-token$/m);
      assert.equal((fs.statSync(envPath).mode & 0o777).toString(8), "600");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not override shell variables from .env", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-test-"));
    const envPath = path.join(directory, ".env");
    try {
      fs.writeFileSync(envPath, "PORT=9999\n");
      withEnvironment({ PORT: "8787" }, () => {
        loadDotEnv(envPath);
        assert.equal(process.env.PORT, "8787");
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
