import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { registerTools } from "./register-tools.js";
import { ZabbixClient } from "./zabbix-client.js";
import { ZabbixService } from "./zabbix-service.js";

const config = loadConfig();
const logger = new Logger(config.logLevel);
const api = new ZabbixClient(config.zabbix, logger);
const service = new ZabbixService(api, config.policy);

function createServer(): McpServer {
  const server = new McpServer({
    name: "zabbix-readonly-aiops",
    version: "0.1.0",
  });
  registerTools(server, service, config.policy.rawQueryMethods);
  return server;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function authenticate(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!config.mcp.authToken) {
    next();
    return;
  }

  const authorization = request.header("authorization") ?? "";
  const prefix = "Bearer ";
  const token = authorization.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : "";

  if (!token || !constantTimeEqual(token, config.mcp.authToken)) {
    response.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "A valid MCP bearer token is required",
      },
    });
    return;
  }
  next();
}

function validateHost(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (config.mcp.allowedHosts.length === 0) {
    next();
    return;
  }

  const hostname = request.hostname.toLowerCase();
  if (!config.mcp.allowedHosts.includes(hostname)) {
    response.status(403).json({
      error: {
        code: "HOST_HEADER_NOT_ALLOWED",
        message: "The request Host header is not allowlisted",
      },
    });
    return;
  }
  next();
}

const app = createMcpExpressApp({ host: config.mcp.host });
app.use(validateHost);

app.get("/healthz", (_request, response) => {
  response.json({
    status: "ok",
    service: "zabbix-readonly-aiops",
    version: "0.1.0",
  });
});

app.post(config.mcp.path, authenticate, async (request, response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    logger.error("mcp_request_failed", {
      error: error instanceof Error ? error.message : "unknown error",
    });
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  } finally {
    await transport.close();
    await server.close();
  }
});

app.get(config.mcp.path, authenticate, (_request, response) => {
  response.status(405).set("Allow", "POST").json({
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: "This stateless MCP endpoint accepts POST requests only",
    },
  });
});

app.delete(config.mcp.path, authenticate, (_request, response) => {
  response.status(405).set("Allow", "POST").json({
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: "This stateless MCP endpoint has no sessions to delete",
    },
  });
});

const httpServer = app.listen(config.mcp.port, config.mcp.host, () => {
  logger.info("mcp_server_started", {
    host: config.mcp.host,
    port: config.mcp.port,
    path: config.mcp.path,
    authentication_enabled: Boolean(config.mcp.authToken),
  });
});

function shutdown(signal: string): void {
  logger.info("mcp_server_stopping", { signal });
  httpServer.close((error) => {
    if (error) {
      logger.error("mcp_server_shutdown_failed", { error: error.message });
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
