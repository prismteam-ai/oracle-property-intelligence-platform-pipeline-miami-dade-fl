import { createMcpHandler } from "mcp-handler";
import { TOOLS } from "@/lib/tools";

export const maxDuration = 60;

/**
 * MCP endpoint (Streamable HTTP). It exposes the same tool catalogue the page's
 * agent uses, so any MCP client gets the same answers from the same snapshot.
 */
const handler = createMcpHandler(
  (server) => {
    for (const spec of TOOLS) {
      server.registerTool(
        spec.name,
        { title: spec.title, description: spec.description, inputSchema: spec.inputSchema },
        async (input: unknown) => {
          try {
            const output = await (spec.run as (input: unknown) => Promise<unknown>)(input);
            return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
          } catch (error) {
            return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Tool failed" }], isError: true };
          }
        },
      );
    }
  },
  { serverInfo: { name: "miami-dade-oracle", version: "0.1.0" } },
);

export { handler as GET, handler as POST, handler as DELETE };
