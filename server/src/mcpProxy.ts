import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isJSONRPCRequest,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

function summarizeMessage(message: JSONRPCMessage): string {
  if ("method" in message) {
    return `method=${message.method}${"id" in message ? ` id=${message.id}` : ""}`;
  }
  if ("result" in message) {
    return `result id=${(message as any).id}`;
  }
  if ("error" in message) {
    return `error id=${(message as any).id} code=${(message as any).error?.code}`;
  }
  return JSON.stringify(message).slice(0, 100);
}

function onClientError(error: Error) {
  console.error("[mcpProxy] Error from inspector client:", error);
}

function onServerError(error: Error) {
  if (error?.cause && JSON.stringify(error.cause).includes("ECONNREFUSED")) {
    console.error("[mcpProxy] Connection refused. Is the MCP server running?");
  } else if (error.message && error.message.includes("404")) {
    console.error("[mcpProxy] Error accessing endpoint (HTTP 404)");
  } else {
    console.error("[mcpProxy] Error from MCP server:", error);
  }
}

/**
 * Filter a tools/list response to only include allowed tools.
 * Returns a new message with filtered tools, or the original if not applicable.
 */
function filterToolsListResponse(
  message: JSONRPCMessage,
  allowedTools: Set<string>,
  pendingToolsListIds: Set<string | number>,
): JSONRPCMessage {
  // Check if this is a response to a tools/list request
  if (!("result" in message) || !("id" in message)) return message;

  const id = (message as any).id;
  if (!pendingToolsListIds.has(id)) return message;

  // This is a response to a tracked tools/list request — remove from tracking
  pendingToolsListIds.delete(id);

  const result = (message as any).result;
  if (!result || !Array.isArray(result.tools)) return message;

  const originalCount = result.tools.length;
  const filteredTools = result.tools.filter((tool: any) =>
    allowedTools.has(tool.name),
  );
  const removedTools = result.tools
    .filter((tool: any) => !allowedTools.has(tool.name))
    .map((t: any) => t.name);

  console.log(
    `[mcpProxy] Filtered tools/list response: ${filteredTools.length}/${originalCount} tools allowed`,
  );
  if (removedTools.length > 0) {
    console.log(
      `[mcpProxy] Removed ${removedTools.length} tool(s): [${removedTools.join(", ")}]`,
    );
  }
  console.log(
    `[mcpProxy] Kept ${filteredTools.length} tool(s): [${filteredTools.map((t: any) => t.name).join(", ")}]`,
  );

  return {
    ...message,
    result: {
      ...result,
      tools: filteredTools,
    },
  } as JSONRPCMessage;
}

/**
 * Check if a tools/call request is for an allowed tool.
 * Returns an error response if the tool is not allowed, or null if it's fine.
 */
function checkToolCallAllowed(
  message: JSONRPCMessage,
  allowedTools: Set<string>,
): JSONRPCMessage | null {
  if (!isJSONRPCRequest(message)) return null;
  if (message.method !== "tools/call") return null;

  const toolName = (message.params as any)?.name;
  if (!toolName || allowedTools.has(toolName)) return null;

  console.log(`[mcpProxy] Blocked tools/call for disabled tool: ${toolName}`);

  return {
    jsonrpc: "2.0" as const,
    id: message.id,
    error: {
      code: -32601,
      message: `Tool "${toolName}" is not enabled for this proxy`,
    },
  } as JSONRPCMessage;
}

export default function mcpProxy({
  transportToClient,
  transportToServer,
  allowedTools,
}: {
  transportToClient: Transport;
  transportToServer: Transport;
  /** Optional set of tool names to expose. If undefined/null, all tools pass through. */
  allowedTools?: Set<string> | null;
}) {
  let transportToClientClosed = false;
  let transportToServerClosed = false;

  let reportedServerSession = false;

  // Track tools/list request IDs so we can filter the responses
  const pendingToolsListIds = new Set<string | number>();
  const isFiltering = allowedTools != null && allowedTools.size > 0;

  if (isFiltering) {
    console.log(
      `[mcpProxy] Tool filtering enabled: ${allowedTools!.size} tool(s) allowed: [${[...allowedTools!].join(", ")}]`,
    );
  } else {
    console.log(`[mcpProxy] No tool filtering — all tools pass through`);
  }

  transportToClient.onmessage = (message) => {
    console.log(`[mcpProxy] Client → Server: ${summarizeMessage(message)}`);

    // If filtering is active, check tools/call requests
    if (isFiltering && isJSONRPCRequest(message)) {
      // Track tools/list requests so we can filter the response
      if (message.method === "tools/list") {
        pendingToolsListIds.add(message.id);
      }

      // Block tools/call for disabled tools
      const errorResponse = checkToolCallAllowed(message, allowedTools!);
      if (errorResponse) {
        transportToClient.send(errorResponse).catch(onClientError);
        return;
      }
    }

    transportToServer.send(message).catch((error) => {
      console.error(`[mcpProxy] Failed to send to server: ${error.message}`);
      // Send error response back to client if it was a request (has id) and connection is still open
      if (isJSONRPCRequest(message) && !transportToClientClosed) {
        const errorResponse = {
          jsonrpc: "2.0" as const,
          id: message.id,
          error: {
            code: -32001,
            message: error.message,
            data: error,
          },
        };
        transportToClient.send(errorResponse).catch(onClientError);
      }
    });
  };

  transportToServer.onmessage = (message) => {
    if (!reportedServerSession) {
      if (transportToServer.sessionId) {
        // Can only report for StreamableHttp
        console.error(
          "Proxy  <-> Server sessionId: " + transportToServer.sessionId,
        );
      }
      reportedServerSession = true;
    }
    console.log(`[mcpProxy] Server → Client: ${summarizeMessage(message)}`);

    // If filtering is active, filter tools/list responses
    let outMessage = message;
    if (isFiltering) {
      outMessage = filterToolsListResponse(
        message,
        allowedTools!,
        pendingToolsListIds,
      );
    }

    transportToClient.send(outMessage).catch((error) => {
      console.error(`[mcpProxy] Failed to send to client: ${error.message}`);
    });
  };

  transportToClient.onclose = () => {
    console.log(
      `[mcpProxy] Client transport closed (serverAlreadyClosed=${transportToServerClosed})`,
    );
    if (transportToServerClosed) {
      return;
    }

    transportToClientClosed = true;
    console.log("[mcpProxy] Cascading close → server transport");
    transportToServer.close().catch(onServerError);
  };

  transportToServer.onclose = () => {
    console.log(
      `[mcpProxy] Server transport closed (clientAlreadyClosed=${transportToClientClosed})`,
    );
    if (transportToClientClosed) {
      return;
    }
    transportToServerClosed = true;
    console.log("[mcpProxy] Cascading close → client transport");
    transportToClient.close().catch(onClientError);
  };

  transportToClient.onerror = (error) => {
    console.error("[mcpProxy] Client transport error:", error);
  };
  transportToServer.onerror = (error) => {
    console.error("[mcpProxy] Server transport error:", error);
  };
}
