import { AppError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { ZabbixApi } from "./types.js";

interface ZabbixResponse<T> {
  jsonrpc: "2.0";
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: string;
  };
  id: number;
}

export interface ZabbixClientOptions {
  url: string;
  apiToken: string;
  timeoutMs: number;
}

export class ZabbixClient implements ZabbixApi {
  private nextId = 1;

  constructor(
    private readonly options: ZabbixClientOptions,
    private readonly logger: Logger,
  ) {}

  async request<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const id = this.nextId++;
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(this.options.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json-rpc",
          Authorization: `Bearer ${this.options.apiToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          params,
          id,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new AppError(
          "ZABBIX_HTTP_ERROR",
          `Zabbix API returned HTTP ${response.status}`,
          {
            status: 502,
            details: { method, http_status: response.status },
          },
        );
      }

      const payload = (await response.json()) as ZabbixResponse<T>;
      if (payload.error) {
        throw new AppError(
          "ZABBIX_API_ERROR",
          `Zabbix API rejected ${method}: ${payload.error.message}`,
          {
            status: 502,
            details: {
              method,
              zabbix_code: payload.error.code,
              zabbix_data: payload.error.data,
            },
          },
        );
      }

      if (!("result" in payload)) {
        throw new AppError(
          "ZABBIX_INVALID_RESPONSE",
          "Zabbix API response did not contain a result",
          { status: 502, details: { method } },
        );
      }

      this.logger.debug("zabbix_api_call", {
        method,
        duration_ms: Math.round(performance.now() - startedAt),
        status: "success",
      });
      return payload.result as T;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new AppError(
          "ZABBIX_TIMEOUT",
          `Zabbix API call timed out after ${this.options.timeoutMs}ms`,
          { status: 504, details: { method } },
        );
      }

      throw new AppError(
        "ZABBIX_CONNECTION_ERROR",
        "Unable to reach the Zabbix API",
        { status: 502, details: { method }, cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
