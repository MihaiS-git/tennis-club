import { assert, test } from "vitest";

import { getApplicationUrl } from "../../../src/lib/auth/site-url";

test("application URLs cannot escape the configured origin", () => {
  const previousUrl = process.env.APP_URL;
  process.env.APP_URL = "https://club.example";

  try {
    assert.strictEqual(
      getApplicationUrl("/auth/callback?next=/account&flow=email-confirmation"),
      "https://club.example/auth/callback?next=/account&flow=email-confirmation",
    );
    assert.throws(
      () => getApplicationUrl("//attacker.example/path"),
      /must stay on APP_URL/,
    );
  } finally {
    if (previousUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousUrl;
  }
});

test("development application URLs use localhost when APP_URL is absent", () => {
  const previousUrl = process.env.APP_URL;
  const previousEnvironment = process.env.NODE_ENV;
  Reflect.deleteProperty(process.env, "APP_URL");
  Object.defineProperty(process.env, "NODE_ENV", {
    configurable: true,
    enumerable: true,
    value: "development",
    writable: true,
  });

  try {
    assert.strictEqual(
      getApplicationUrl("/auth/callback?next=/account&flow=email-confirmation"),
      "http://localhost:3000/auth/callback?next=/account&flow=email-confirmation",
    );
  } finally {
    if (previousUrl === undefined) Reflect.deleteProperty(process.env, "APP_URL");
    else process.env.APP_URL = previousUrl;
    if (previousEnvironment === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      Object.defineProperty(process.env, "NODE_ENV", {
        configurable: true,
        enumerable: true,
        value: previousEnvironment,
        writable: true,
      });
    }
  }
});

test("production application URLs require APP_URL", () => {
  const previousUrl = process.env.APP_URL;
  const previousEnvironment = process.env.NODE_ENV;
  Reflect.deleteProperty(process.env, "APP_URL");
  Object.defineProperty(process.env, "NODE_ENV", {
    configurable: true,
    enumerable: true,
    value: "production",
    writable: true,
  });

  try {
    assert.throws(
      () => getApplicationUrl("/auth/callback"),
      /APP_URL is required in production/,
    );
  } finally {
    if (previousUrl === undefined) Reflect.deleteProperty(process.env, "APP_URL");
    else process.env.APP_URL = previousUrl;
    if (previousEnvironment === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      Object.defineProperty(process.env, "NODE_ENV", {
        configurable: true,
        enumerable: true,
        value: previousEnvironment,
        writable: true,
      });
    }
  }
});
