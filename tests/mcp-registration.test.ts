import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerTools } from "../src/register-tools.js";
import type { ZabbixApi } from "../src/types.js";
import { ZabbixService } from "../src/zabbix-service.js";

const unusedApi: ZabbixApi = {
  request: async <T>(): Promise<T> => {
    throw new Error("The registration test must not call Zabbix");
  },
};

describe("MCP tool registration", () => {
  it("advertises exactly the seven read-only investigation tools", async () => {
    const service = new ZabbixService(unusedApi, {
      maxWindowHours: 26,
      longTermMaxDays: 30,
      maxEvents: 100,
      maxItemsPerCall: 20,
      maxHistoryPoints: 1_000,
      maxSourcePoints: 50_000,
      maxFutureHours: 2,
      allowedHostGroupIds: [],
    });
    const server = new McpServer({
      name: "registration-test",
      version: "0.1.0",
    });
    registerTools(server, service);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "registration-test-client",
      version: "0.1.0",
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "find_hosts",
      "get_incident_events",
      "get_metric_history",
      "get_metric_summary",
      "get_related_events",
      "get_trigger_details",
      "list_relevant_metrics",
    ]);

    await client.close();
    await server.close();
  });
});
