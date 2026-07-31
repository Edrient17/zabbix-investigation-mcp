import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { AppError } from "./errors.js";
import type { AppConfig } from "./types.js";

function loadLocalEnvironment(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadEnvFile(candidate);
      return;
    }
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new AppError(
      "CONFIG_ERROR",
      `Required environment variable is missing: ${name}`,
      { status: 500 },
    );
  }
  return value;
}

function integer(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AppError(
      "CONFIG_ERROR",
      `${name} must be an integer greater than or equal to ${minimum}`,
      { status: 500 },
    );
  }
  return value;
}

function ratio(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AppError(
      "CONFIG_ERROR",
      `${name} must be a number between 0 and 1`,
      { status: 500 },
    );
  }
  return value;
}

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  loadLocalEnvironment();

  const logLevel = process.env.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new AppError(
      "CONFIG_ERROR",
      "LOG_LEVEL must be one of debug, info, warn, error",
      { status: 500 },
    );
  }

  const mcpPath = process.env.MCP_PATH?.trim() || "/mcp";
  if (!mcpPath.startsWith("/")) {
    throw new AppError("CONFIG_ERROR", "MCP_PATH must start with '/'", {
      status: 500,
    });
  }

  return {
    zabbix: {
      url: required("ZABBIX_URL"),
      apiToken: required("ZABBIX_API_TOKEN"),
      timeoutMs: integer("ZABBIX_API_TIMEOUT_MS", 20_000, 100),
    },
    mcp: {
      host: process.env.MCP_HOST?.trim() || "0.0.0.0",
      port: integer("MCP_PORT", 3000),
      path: mcpPath,
      authToken: process.env.ZABBIX_MCP_AUTH_TOKEN?.trim() || null,
      allowedHosts: csv("MCP_ALLOWED_HOSTS").map((value) =>
        value.toLowerCase(),
      ),
    },
    policy: {
      maxWindowHours: integer("INVESTIGATION_MAX_WINDOW_HOURS", 26),
      longTermMaxDays: integer("INVESTIGATION_LONG_TERM_MAX_DAYS", 30),
      maxEvents: integer("INVESTIGATION_MAX_EVENTS", 100),
      maxItemsPerCall: integer("INVESTIGATION_MAX_ITEMS_PER_CALL", 20),
      maxHistoryPoints: integer(
        "INVESTIGATION_MAX_HISTORY_POINTS",
        1_000,
      ),
      maxSourcePoints: integer(
        "INVESTIGATION_MAX_SOURCE_POINTS",
        50_000,
      ),
      maxFutureHours: integer("INVESTIGATION_MAX_FUTURE_HOURS", 2),
      minCoverageRatio: ratio("INVESTIGATION_MIN_COVERAGE_RATIO", 0.95),
      allowedHostGroupIds: csv("ZABBIX_ALLOWED_HOST_GROUP_IDS"),
    },
    defaultTimezone: process.env.DEFAULT_TIMEZONE?.trim() || "Asia/Seoul",
    logLevel: logLevel as AppConfig["logLevel"],
  };
}
