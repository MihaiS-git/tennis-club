import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { assertTestEnvironment } from "./environment.mjs";

assertTestEnvironment();
const recovery = "Run npx supabase stop --workdir tests/local, then npx supabase start --workdir tests/local (without --no-backup). Inspect Docker networking if the problem persists. Never reset the development project.";

try {
  // CLI status reports configured URLs even when a healthy container has lost
  // its Docker network endpoint. Check the endpoints used by the tests as well.
  for (const [name, url] of [
    ["Supabase Auth", `${process.env.SUPABASE_URL}/auth/v1/health`],
    ["Mailpit readiness", `${process.env.MAILPIT_URL}/readyz`],
    ["Mailpit message API", `${process.env.MAILPIT_URL}/api/v1/messages?limit=1`],
  ]) {
    try {
      const response = await fetch(url, {
        headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.arrayBuffer();
    } catch (error) {
      throw new Error(`${name} unavailable at ${url}: ${error.cause?.code ?? error.message}`);
    }
  }
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: 55325 });
    socket.setTimeout(3000);
    socket.once("data", data => {
      socket.destroy();
      if (data.toString().startsWith("220")) resolve();
      else reject(new Error("Mailpit SMTP did not return its ready greeting on 127.0.0.1:55325"));
    });
    socket.once("timeout", () => socket.destroy(new Error("Mailpit SMTP readiness timed out")));
    socket.once("error", error => reject(new Error(`Mailpit SMTP unavailable at 127.0.0.1:55325: ${error.message}`)));
  });
  // Auth uses the container hostname and port 1025, not the host's 55325.
  const networks = ["auth", "inbucket"].map(service => JSON.parse(execFileSync("docker", [
    "inspect", `supabase_${service}_tennis-club-tests`,
    "--format", "{{json .NetworkSettings.Networks}}",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000 })));
  if (!Object.keys(networks[0]).some(name => networks[1][name])) {
    throw new Error("Supabase Auth and Mailpit have no shared Docker network; Auth cannot resolve its SMTP host supabase_inbucket_tennis-club-tests:1025");
  }
} catch (error) {
  console.error(`Isolated test service readiness failed: ${error.message}\n${recovery}`);
  process.exitCode = 1;
}
