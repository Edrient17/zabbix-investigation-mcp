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
  it("advertises constrained, example-free read-only tool schemas", async () => {
    const service = new ZabbixService(unusedApi, {
      maxWindowHours: 26,
      longTermMaxDays: 30,
      maxEvents: 100,
      maxItemsPerCall: 20,
      maxHistoryPoints: 1_000,
      maxSourcePoints: 50_000,
      maxFutureHours: 2,
      minCoverageRatio: 0.95,
      allowedHostGroupIds: [],
      maxRawRows: 50,
      maxRawResultChars: 12_000,
      rawQueryMethods: [],
    });
    const server = new McpServer({
      name: "registration-test",
      version: "0.1.0",
    });
    registerTools(server, service, ["host.get", "event.get"]);

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
      // The escape hatch. Reads only, and only the methods on its own list --
      // the write methods are absent rather than refused, so no rejection path
      // has to be correct for Zabbix to stay unmodified.
      "query_zabbix",
    ]);

    const schemaProperty = (
      toolName: string,
      propertyName: string,
    ): Record<string, unknown> => {
      const tool = result.tools.find((candidate) => candidate.name === toolName);
      if (!tool) throw new Error(`missing tool ${toolName}`);
      const properties = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      return properties[propertyName]!;
    };

    expect(schemaProperty("query_zabbix", "method").enum).toEqual([
      "event.get",
      "host.get",
    ]);
    for (const toolName of [
      "get_incident_events",
      "get_metric_summary",
      "get_metric_history",
      "get_related_events",
    ]) {
      expect(schemaProperty(toolName, "time_from").format).toBe("date-time");
      expect(schemaProperty(toolName, "time_to").format).toBe("date-time");
    }

    const advertised = JSON.stringify(result.tools);
    expect(advertised).not.toMatch(/e\.g\.|for example|auditlog\.get/i);

    await client.close();
    await server.close();
  });
});
