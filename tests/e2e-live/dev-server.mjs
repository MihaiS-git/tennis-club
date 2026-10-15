// Real Stripe test-mode lifecycle server: `next dev` on :3100 against the isolated
// test Supabase project. Stripe test keys come from Next's own .env.local loading.
// The hold override applies only when E2E_ALLOW_HOLD_OVERRIDE=1 is passed explicitly.
import { spawn } from "node:child_process";
import { configureTestEnvironment } from "../local/environment.mjs";

configureTestEnvironment();
for (const key of ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_TEST_API_URL"]) delete process.env[key];
Object.assign(process.env, { APP_URL: "http://localhost:3100", PLAYWRIGHT_APP_URL: "http://localhost:3100" });
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--port", "3100"], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => { process.exitCode = code ?? 1; });
