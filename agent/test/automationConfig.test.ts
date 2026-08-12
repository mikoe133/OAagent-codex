import assert from "node:assert/strict";
import test from "node:test";

import { parseAutomationConfig } from "../src/config/automationConfig.js";

test("disables storage cleanly when DATABASE_URL is absent", () => {
  const config = parseAutomationConfig({});

  assert.equal(config.databaseUrl, null);
  assert.equal(config.maintenanceEnabled, false);
  assert.equal(config.sessionVerifyMaxAgeSeconds, 0);
});

test("parses the Node automation runtime settings", () => {
  const config = parseAutomationConfig({
    DATABASE_URL: "mysql://oagent:p%21ss@db.example.test:3306/oagent_test",
    OA_SESSION_SECRET: "shared-secret",
    OA_SESSION_VERIFY_MAX_AGE: "86400",
    AUTOMATION_MAINTENANCE_ENABLED: "true",
    AUTOMATION_SCHEDULE_GRACE_SECONDS: "120",
    AUTOMATION_MANUAL_TRIGGER_LIMIT: "3",
    AUTOMATION_MANUAL_TRIGGER_WINDOW_SECONDS: "300",
  });

  assert.equal(config.databaseUrl?.protocol, "mysql:");
  assert.equal(config.databaseUrl?.password, "p!ss");
  assert.equal(config.databaseUrl?.pathname, "/oagent_test");
  assert.equal(config.sessionSecret, "shared-secret");
  assert.equal(config.sessionVerifyMaxAgeSeconds, 86400);
  assert.equal(config.maintenanceEnabled, true);
  assert.equal(config.scheduleGraceSeconds, 120);
  assert.equal(config.manualTriggerLimit, 3);
});

test("requires the shared OA session secret when storage is enabled", () => {
  assert.throws(
    () =>
      parseAutomationConfig({
        DATABASE_URL: "mysql://oagent:password@localhost:3306/oagent_test",
      }),
    /OA_SESSION_SECRET/,
  );
});

test("rejects unsupported database protocols and invalid booleans", () => {
  assert.throws(
    () =>
      parseAutomationConfig({
        DATABASE_URL: "postgresql://localhost/oagent",
        OA_SESSION_SECRET: "secret",
      }),
    /mysql/,
  );
  assert.throws(
    () =>
      parseAutomationConfig({
        AUTOMATION_MAINTENANCE_ENABLED: "yes",
      }),
    /AUTOMATION_MAINTENANCE_ENABLED/,
  );
});

