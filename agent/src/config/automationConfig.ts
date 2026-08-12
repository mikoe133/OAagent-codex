export type AutomationConfig = {
  databaseUrl: URL | null;
  sessionSecret: string | null;
  sessionVerifyMaxAgeSeconds: number;
  maintenanceEnabled: boolean;
  migrateOnStart: boolean;
  modelCatalogTtlSeconds: number;
  modelCatalogStaleSeconds: number;
  scheduleGraceSeconds: number;
  manualTriggerLimit: number;
  manualTriggerWindowSeconds: number;
  maintenanceIntervalSeconds: number;
};

type Environment = Record<string, string | undefined>;

export function parseAutomationConfig(env: Environment): AutomationConfig {
  const databaseUrl = parseDatabaseUrl(env.DATABASE_URL);
  const sessionSecret = optionalString(env.OA_SESSION_SECRET);
  if (databaseUrl && !sessionSecret) {
    throw new Error(
      "配置 DATABASE_URL 时必须同时配置 OA_SESSION_SECRET，以验证原 OA 的 sessionid。",
    );
  }

  return {
    databaseUrl,
    sessionSecret,
    sessionVerifyMaxAgeSeconds: integerSetting(
      env,
      "OA_SESSION_VERIFY_MAX_AGE",
      0,
      0,
      3650 * 24 * 60 * 60,
    ),
    maintenanceEnabled: booleanSetting(
      env,
      "AUTOMATION_MAINTENANCE_ENABLED",
      false,
    ),
    migrateOnStart: booleanSetting(
      env,
      "AUTOMATION_MIGRATE_ON_START",
      false,
    ),
    modelCatalogTtlSeconds: integerSetting(
      env,
      "AUTOMATION_MODEL_CATALOG_TTL_SECONDS",
      300,
      1,
      86_400,
    ),
    modelCatalogStaleSeconds: integerSetting(
      env,
      "AUTOMATION_MODEL_CATALOG_STALE_SECONDS",
      86_400,
      1,
      31_536_000,
    ),
    scheduleGraceSeconds: integerSetting(
      env,
      "AUTOMATION_SCHEDULE_GRACE_SECONDS",
      120,
      0,
      86_400,
    ),
    manualTriggerLimit: integerSetting(
      env,
      "AUTOMATION_MANUAL_TRIGGER_LIMIT",
      3,
      1,
      1000,
    ),
    manualTriggerWindowSeconds: integerSetting(
      env,
      "AUTOMATION_MANUAL_TRIGGER_WINDOW_SECONDS",
      300,
      1,
      86_400,
    ),
    maintenanceIntervalSeconds: integerSetting(
      env,
      "AUTOMATION_MAINTENANCE_INTERVAL_SECONDS",
      30,
      5,
      3600,
    ),
  };
}

function parseDatabaseUrl(value: string | undefined): URL | null {
  const normalized = optionalString(value);
  if (!normalized) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("DATABASE_URL 必须是合法的 mysql:// URL。");
  }
  if (parsed.protocol !== "mysql:") {
    throw new Error("DATABASE_URL 只支持 mysql:// 协议。");
  }
  if (!parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error("DATABASE_URL 必须包含 MySQL host 和 database name。");
  }
  try {
    parsed.username = decodeURIComponent(parsed.username);
    parsed.password = decodeURIComponent(parsed.password);
  } catch {
    throw new Error("DATABASE_URL 用户名或密码 URL 编码无效。");
  }
  return parsed;
}

function booleanSetting(
  env: Environment,
  name: string,
  fallback: boolean,
): boolean {
  const value = optionalString(env[name]);
  if (!value) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} 必须是 true 或 false。`);
}

function integerSetting(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = optionalString(env[name]);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 的整数。`);
  }
  return parsed;
}

function optionalString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

