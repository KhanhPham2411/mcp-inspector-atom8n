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

export default function mcpProxy({
  transportToClient,
  transportToServer,
}: {
  transportToClient: Transport;
  transportToServer: Transport;
}) {
  let transportToClientClosed = false;
  let transportToServerClosed = false;

  let reportedServerSession = false;

  transportToClient.onmessage = (message) => {
    console.log(`[mcpProxy] Client → Server: ${summarizeMessage(message)}`);
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
    transportToClient.send(message).catch((error) => {
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
