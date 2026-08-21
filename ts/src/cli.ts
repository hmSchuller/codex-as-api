import { main } from "./runtime.js";

try {
  await main({ withTunnel: !process.argv.includes("--local") });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
