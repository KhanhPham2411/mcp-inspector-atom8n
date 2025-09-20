#!/usr/bin/env node

import cors from "cors";
import { parseArgs } from "node:util";
import { parse as shellParseArgs } from "shell-quote";

import {
  SSEClientTransport,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import express from "express";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { findActualExecutable } from "spawn-rx";
import mcpProxy from "./mcpProxy.js";
import logger from "./logger.js";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_MCP_PROXY_LISTEN_PORT = "6277";

const defaultEnvironment = {
  ...getDefaultEnvironment(),
  ...(process.env.MCP_ENV_VARS ? JSON.parse(process.env.MCP_ENV_VARS) : {}),
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    env: { type: "string", default: "" },
    args: { type: "string", default: "" },
    command: { type: "string", default: "" },
    transport: { type: "string", default: "" },
    "server-url": { type: "string", default: "" },
  },
});

// Function to get HTTP headers.
const getHttpHeaders = (req: express.Request): Record<string, string> => {
  const headers: Record<string, string> = {};

  // Iterate over all headers in the request
  for (const key in req.headers) {
    const lowerKey = key.toLowerCase();

    // Check if the header is one we want to forward
    if (
      lowerKey.startsWith("mcp-") ||
      lowerKey === "authorization" ||
      lowerKey === "last-event-id"
    ) {
      // Exclude the proxy's own authentication header and the Client <-> Proxy session ID header
      if (lowerKey !== "x-mcp-proxy-auth" && lowerKey !== "mcp-session-id") {
        const value = req.headers[key];

        if (typeof value === "string") {
          // If the value is a string, use it directly
          headers[key] = value;
        } else if (Array.isArray(value)) {
          // If the value is an array, use the last element
          const lastValue = value.at(-1);
          if (lastValue !== undefined) {
            headers[key] = lastValue;
          }
        }
        // If value is undefined, it's skipped, which is correct.
      }
    }
  }

  // Handle the custom auth header separately. We expect `x-custom-auth-header`
  // to be a string containing the name of the actual authentication header.
  const customAuthHeaderName = req.headers["x-custom-auth-header"];
  if (typeof customAuthHeaderName === "string") {
    const lowerCaseHeaderName = customAuthHeaderName.toLowerCase();
    const value = req.headers[lowerCaseHeaderName];

    if (typeof value === "string") {
      headers[customAuthHeaderName] = value;
    } else if (Array.isArray(value)) {
      // If the actual auth header was sent multiple times, use the last value.
      const lastValue = value.at(-1);
      if (lastValue !== undefined) {
        headers[customAuthHeaderName] = lastValue;
      }
    }
  }

  // Handle multiple custom headers (new approach)
  if (req.headers["x-custom-auth-headers"] !== undefined) {
    try {
      const customHeaderNames = JSON.parse(
        req.headers["x-custom-auth-headers"] as string,
      ) as string[];
      if (Array.isArray(customHeaderNames)) {
        customHeaderNames.forEach((headerName) => {
          const lowerCaseHeaderName = headerName.toLowerCase();
          if (req.headers[lowerCaseHeaderName] !== undefined) {
            const value = req.headers[lowerCaseHeaderName];
            headers[headerName] = Array.isArray(value)
              ? value[value.length - 1]
              : value;
          }
        });
      }
    } catch (error) {
      console.warn("Failed to parse x-custom-auth-headers:", error);
    }
  }
  return headers;
};

/**
 * Updates a headers object in-place, preserving the original Accept header.
 * This is necessary to ensure that transports holding a reference to the headers
 * object see the updates.
 * @param currentHeaders The headers object to update.
 * @param newHeaders The new headers to apply.
 */
const updateHeadersInPlace = (
  currentHeaders: Record<string, string>,
  newHeaders: Record<string, string>,
) => {
  // Preserve the Accept header, which is set at transport creation and
  // is not present in subsequent client requests.
  const accept = currentHeaders["Accept"];

  // Clear the old headers and apply the new ones.
  Object.keys(currentHeaders).forEach((key) => delete currentHeaders[key]);
  Object.assign(currentHeaders, newHeaders);

  // Restore the Accept header.
  if (accept) {
    currentHeaders["Accept"] = accept;
  }
};

const app = express();
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  next();
});

const webAppTransports: Map<string, Transport> = new Map<string, Transport>(); // Web app transports by web app sessionId
const serverTransports: Map<string, Transport> = new Map<string, Transport>(); // Server Transports by web app sessionId
const sessionHeaderHolders: Map<string, { headers: HeadersInit }> = new Map(); // For dynamic header updates

// Use provided token from environment or generate a new one
const sessionToken =
  process.env.MCP_PROXY_AUTH_TOKEN || randomBytes(32).toString("hex");
const authDisabled = !!process.env.DANGEROUSLY_OMIT_AUTH;

// Origin validation middleware to prevent DNS rebinding attacks
const originValidationMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const origin = req.headers.origin;

  // Default origins based on CLIENT_PORT or use environment variable
  const clientPort = process.env.CLIENT_PORT || "6274";
  const defaultOrigin = `http://localhost:${clientPort}`;
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
    defaultOrigin,
  ];

  if (origin && !allowedOrigins.includes(origin)) {
    console.error(`Invalid origin: ${origin}`);
    res.status(403).json({
      error: "Forbidden - invalid origin",
      message:
        "Request blocked to prevent DNS rebinding attacks. Configure allowed origins via environment variable.",
    });
    return;
  }
  next();
};

const authMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (authDisabled) {
    return next();
  }

  const sendUnauthorized = () => {
    res.status(401).json({
      error: "Unauthorized",
      message:
        "Authentication required. Use the session token shown in the console when starting the server.",
    });
  };

  const authHeader = req.headers["x-mcp-proxy-auth"];
  const authHeaderValue = Array.isArray(authHeader)
    ? authHeader[0]
    : authHeader;

  if (!authHeaderValue || !authHeaderValue.startsWith("Bearer ")) {
    sendUnauthorized();
    return;
  }

  const providedToken = authHeaderValue.substring(7); // Remove 'Bearer ' prefix
  const expectedToken = sessionToken;

  // Convert to buffers for timing-safe comparison
  const providedBuffer = Buffer.from(providedToken);
  const expectedBuffer = Buffer.from(expectedToken);

  // Check length first to prevent timing attacks
  if (providedBuffer.length !== expectedBuffer.length) {
    sendUnauthorized();
    return;
  }

  // Perform timing-safe comparison
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    sendUnauthorized();
    return;
  }

  next();
};

/**
 * Creates a `fetch` function that merges dynamic session headers with the
 * headers from the actual request, ensuring that request-specific headers like
 * `Content-Type` are preserved.
 */
const createCustomFetch = (headerHolder: { headers: HeadersInit }) => {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Determine the headers from the original request/init.
    // The SDK may pass a Request object or a URL and an init object.
    const originalHeaders =
      input instanceof Request ? input.headers : init?.headers;

    // Start with our dynamic session headers.
    const finalHeaders = new Headers(headerHolder.headers);

    // Merge the SDK's request-specific headers, letting them overwrite.
    // This is crucial for preserving Content-Type on POST requests.
    new Headers(originalHeaders).forEach((value, key) => {
      finalHeaders.set(key, value);
    });

    // This works for both `fetch(url, init)` and `fetch(request)` style calls.
    return fetch(input, { ...init, headers: finalHeaders });
  };
};

const createTransport = async (
  req: express.Request,
): Promise<{
  transport: Transport;
  headerHolder?: { headers: HeadersInit };
}> => {
  const query = req.query;
  logger.info("Query parameters:", JSON.stringify(query));

  const transportType = query.transportType as string;

  if (transportType === "stdio") {
    const command = (query.command as string).trim();
    const origArgs = shellParseArgs(query.args as string) as string[];
    const queryEnv = query.env ? JSON.parse(query.env as string) : {};
    const env = { ...defaultEnvironment, ...process.env, ...queryEnv };

    const { cmd, args } = findActualExecutable(command, origArgs);

    logger.info(`STDIO transport: command=${cmd}, args=${args}`);

    const transport = new StdioClientTransport({
      command: cmd,
      args,
      env,
      stderr: "pipe",
    });

    await transport.start();
    return { transport };
  } else if (transportType === "sse") {
    const url = query.url as string;

    const headers = getHttpHeaders(req);
    headers["Accept"] = "text/event-stream";
    const headerHolder = { headers };

    logger.info(
      `SSE transport: url=${url}, headers=${JSON.stringify(headers)}`,
    );

    const transport = new SSEClientTransport(new URL(url), {
      eventSourceInit: {
        fetch: createCustomFetch(headerHolder),
      },
      requestInit: {
        headers: headerHolder.headers,
      },
    });
    await transport.start();
    return { transport, headerHolder };
  } else if (transportType === "streamable-http") {
    const headers = getHttpHeaders(req);
    headers["Accept"] = "text/event-stream, application/json";
    const headerHolder = { headers };

    const transport = new StreamableHTTPClientTransport(
      new URL(query.url as string),
      {
        // Pass a custom fetch to inject the latest headers on each request
        fetch: createCustomFetch(headerHolder),
      },
    );
    await transport.start();
    return { transport, headerHolder };
  } else {
    logger.error(`Invalid transport type: ${transportType}`);
    throw new Error("Invalid transport type specified");
  }
};

app.get(
  "/mcp",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    logger.info(`Received GET message for sessionId ${sessionId}`);

    const headerHolder = sessionHeaderHolders.get(sessionId);
    if (headerHolder) {
      updateHeadersInPlace(
        headerHolder.headers as Record<string, string>,
        getHttpHeaders(req),
      );
    }

    try {
      const transport = webAppTransports.get(
        sessionId,
      ) as StreamableHTTPServerTransport;
      if (!transport) {
        res.status(404).end("Session not found");
        return;
      } else {
        await transport.handleRequest(req, res);
      }
    } catch (error) {
      logger.error("Error in /mcp route:", error);
      res.status(500).json(error);
    }
  },
);

app.post(
  "/mcp",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      console.log(`Received POST message for sessionId ${sessionId}`);
      const headerHolder = sessionHeaderHolders.get(sessionId);
      if (headerHolder) {
        updateHeadersInPlace(
          headerHolder.headers as Record<string, string>,
          getHttpHeaders(req),
        );
      }

      try {
        const transport = webAppTransports.get(
          sessionId,
        ) as StreamableHTTPServerTransport;
        if (!transport) {
          res.status(404).end("Transport not found for sessionId " + sessionId);
        } else {
          await (transport as StreamableHTTPServerTransport).handleRequest(
            req,
            res,
          );
        }
      } catch (error) {
        console.error("Error in /mcp route:", error);
        res.status(500).json(error);
      }
    } else {
      console.log("New StreamableHttp connection request");
      try {
        const { transport: serverTransport, headerHolder } =
          await createTransport(req);

        const webAppTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (sessionId) => {
            webAppTransports.set(sessionId, webAppTransport);
            serverTransports.set(sessionId, serverTransport!); // eslint-disable-line @typescript-eslint/no-non-null-assertion
            if (headerHolder) {
              sessionHeaderHolders.set(sessionId, headerHolder);
            }
            console.log("Client <-> Proxy  sessionId: " + sessionId);
          },
          onsessionclosed: (sessionId) => {
            webAppTransports.delete(sessionId);
            serverTransports.delete(sessionId);
            sessionHeaderHolders.delete(sessionId);
          },
        });
        console.log("Created StreamableHttp client transport");

        await webAppTransport.start();

        mcpProxy({
          transportToClient: webAppTransport,
          transportToServer: serverTransport,
        });

        await (webAppTransport as StreamableHTTPServerTransport).handleRequest(
          req,
          res,
          req.body,
        );
      } catch (error) {
        if (error instanceof SseError && error.code === 401) {
          console.error(
            "Received 401 Unauthorized from MCP server:",
            error.message,
          );
          res.status(401).json(error);
          return;
        }
        console.error("Error in /mcp POST route:", error);
        res.status(500).json(error);
      }
    }
  },
);

app.delete(
  "/mcp",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    console.log(`Received DELETE message for sessionId ${sessionId}`);
    if (sessionId) {
      try {
        const serverTransport = serverTransports.get(
          sessionId,
        ) as StreamableHTTPClientTransport;
        if (!serverTransport) {
          res.status(404).end("Transport not found for sessionId " + sessionId);
        } else {
          await serverTransport.terminateSession();
          webAppTransports.delete(sessionId);
          serverTransports.delete(sessionId);
          sessionHeaderHolders.delete(sessionId);
          console.log(`Transports removed for sessionId ${sessionId}`);
        }
        res.status(200).end();
      } catch (error) {
        console.error("Error in /mcp route:", error);
        res.status(500).json(error);
      }
    }
  },
);

app.get(
  "/stdio",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      console.log("New STDIO connection request");
      const { transport: serverTransport } = await createTransport(req);

      const proxyFullAddress = (req.query.proxyFullAddress as string) || "";
      const prefix = proxyFullAddress || "";
      const endpoint = `${prefix}/message`;

      const webAppTransport = new SSEServerTransport(endpoint, res);
      webAppTransports.set(webAppTransport.sessionId, webAppTransport);
      console.log("Created client transport");

      serverTransports.set(webAppTransport.sessionId, serverTransport);
      console.log("Created server transport");

      await webAppTransport.start();

      (serverTransport as StdioClientTransport).stderr!.on("data", (chunk) => {
        if (chunk.toString().includes("MODULE_NOT_FOUND")) {
          // Server command not found, remove transports
          const message = "Command not found, transports removed";
          webAppTransport.send({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: {
              level: "emergency",
              logger: "proxy",
              data: {
                message,
              },
            },
          });
          webAppTransport.close();
          serverTransport.close();
          webAppTransports.delete(webAppTransport.sessionId);
          serverTransports.delete(webAppTransport.sessionId);
          sessionHeaderHolders.delete(webAppTransport.sessionId);
          console.error(message);
        } else {
          // Inspect message and attempt to assign a RFC 5424 Syslog Protocol level
          let level;
          let message = chunk.toString().trim();
          let ucMsg = chunk.toString().toUpperCase();
          if (ucMsg.includes("DEBUG")) {
            level = "debug";
          } else if (ucMsg.includes("INFO")) {
            level = "info";
          } else if (ucMsg.includes("NOTICE")) {
            level = "notice";
          } else if (ucMsg.includes("WARN")) {
            level = "warning";
          } else if (ucMsg.includes("ERROR")) {
            level = "error";
          } else if (ucMsg.includes("CRITICAL")) {
            level = "critical";
          } else if (ucMsg.includes("ALERT")) {
            level = "alert";
          } else if (ucMsg.includes("EMERGENCY")) {
            level = "emergency";
          } else if (ucMsg.includes("SIGINT")) {
            message = "SIGINT received. Server shutdown.";
            level = "emergency";
          } else if (ucMsg.includes("SIGHUP")) {
            message = "SIGHUP received. Server shutdown.";
            level = "emergency";
          } else if (ucMsg.includes("SIGTERM")) {
            message = "SIGTERM received. Server shutdown.";
            level = "emergency";
          } else {
            level = "info";
          }
          webAppTransport.send({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: {
              level,
              logger: "stdio",
              data: {
                message,
              },
            },
          });
        }
      });

      mcpProxy({
        transportToClient: webAppTransport,
        transportToServer: serverTransport,
      });
    } catch (error) {
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "Received 401 Unauthorized from MCP server. Authentication failure.",
        );
        res.status(401).json(error);
        return;
      }
      console.error("Error in /stdio route:", error);
      res.status(500).json(error);
    }
  },
);

app.get(
  "/sse",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      console.log(
        "New SSE connection request. NOTE: The SSE transport is deprecated and has been replaced by StreamableHttp",
      );
      const { transport: serverTransport, headerHolder } =
        await createTransport(req);

      const proxyFullAddress = (req.query.proxyFullAddress as string) || "";
      const prefix = proxyFullAddress || "";
      const endpoint = `${prefix}/message`;

      const webAppTransport = new SSEServerTransport(endpoint, res);
      webAppTransports.set(webAppTransport.sessionId, webAppTransport);
      console.log("Created client transport");

      serverTransports.set(webAppTransport.sessionId, serverTransport!); // eslint-disable-line @typescript-eslint/no-non-null-assertion
      if (headerHolder) {
        sessionHeaderHolders.set(webAppTransport.sessionId, headerHolder);
      }
      console.log("Created server transport");

      await webAppTransport.start();

      mcpProxy({
        transportToClient: webAppTransport,
        transportToServer: serverTransport,
      });
    } catch (error) {
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "Received 401 Unauthorized from MCP server. Authentication failure.",
        );
        res.status(401).json(error);
        return;
      } else if (error instanceof SseError && error.code === 404) {
        console.error(
          "Received 404 not found from MCP server. Does the MCP server support SSE?",
        );
        res.status(404).json(error);
        return;
      } else if (JSON.stringify(error).includes("ECONNREFUSED")) {
        console.error("Connection refused. Is the MCP server running?");
        res.status(500).json(error);
      }
      console.error("Error in /sse route:", error);
      res.status(500).json(error);
    }
  },
);

app.post(
  "/message",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      const sessionId = req.query.sessionId as string;
      console.log(`Received POST message for sessionId ${sessionId}`);

      const headerHolder = sessionHeaderHolders.get(sessionId);
      if (headerHolder) {
        updateHeadersInPlace(
          headerHolder.headers as Record<string, string>,
          getHttpHeaders(req),
        );
      }

      const transport = webAppTransports.get(sessionId) as SSEServerTransport;
      if (!transport) {
        res.status(404).end("Session not found");
        return;
      }
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error("Error in /message route:", error);
      res.status(500).json(error);
    }
  },
);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

// CORS-friendly JSON fetch proxy for MCP Store
// Usage: GET /fetch-json?url=<encodedUrl>
// - Validates origin and requires auth (same as other endpoints)
// - Supports transforming common GitHub/Gist page URLs to raw URLs
app.get(
  "/fetch-json",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      const targetUrl = (req.query.url as string) || "";
      if (!targetUrl) {
        res.status(400).json({ error: "Bad Request", message: "Missing 'url' query parameter" });
        return;
      }

      const safeUrl = (() => {
        try {
          const u = new URL(targetUrl);
          if (!/^https?:$/.test(u.protocol)) {
            throw new Error("Only http/https protocols are allowed");
          }
          // Transform common GitHub/Gist page URLs to raw content URLs
          const host = u.hostname.toLowerCase();
          if (host === "gist.github.com") {
            // Expected formats:
            // https://gist.github.com/<user>/<id>
            // https://gist.github.com/<user>/<id>#file-...
            const parts = u.pathname.split("/").filter(Boolean);
            if (parts.length >= 2) {
              const user = parts[0];
              const id = parts[1];
              return new URL(`https://gist.githubusercontent.com/${user}/${id}/raw`).toString();
            }
          }
          if (host === "github.com") {
            // Transform blob URLs to raw
            // https://github.com/<user>/<repo>/blob/<branch>/<path>
            const parts = u.pathname.split("/").filter(Boolean);
            const blobIndex = parts.indexOf("blob");
            if (blobIndex !== -1 && parts.length > blobIndex + 1) {
              const user = parts[0];
              const repo = parts[1];
              const branch = parts[blobIndex + 1];
              const filePath = parts.slice(blobIndex + 2).join("/");
              return new URL(`https://raw.githubusercontent.com/${user}/${repo}/${branch}/${filePath}`).toString();
            }
          }
          return u.toString();
        } catch (e) {
          throw new Error(`Invalid URL: ${String(e instanceof Error ? e.message : e)}`);
        }
      })();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const resp = await fetch(safeUrl, {
          headers: { "User-Agent": "mcp-inspector-proxy" },
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          res.status(resp.status).json({ error: "UpstreamError", message: text || resp.statusText });
          return;
        }
        const contentType = resp.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          // Try to parse as JSON anyway
          const text = await resp.text();
          try {
            const json = JSON.parse(text);
            res.json(json);
            return;
          } catch {
            res.status(415).json({ error: "Unsupported Media Type", message: "Upstream did not return JSON" });
            return;
          }
        }
        const json = await resp.json();
        res.json(json);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error: any) {
      console.error("Error in /fetch-json:", error);
      res.status(500).json({ error: "Internal Server Error", message: error?.message || String(error) });
    }
  },
);

// Returns the default Cursor MCP configuration from the user's home directory
// Default path: <home>/.cursor/mcp.json (cross-platform)
app.get(
  "/mcp-config",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      // Allow overriding the path via query param for flexibility/testing
      const overridePath = (req.query.path as string) || "";
      const homeDir = os.homedir();
      const defaultPath = path.join(homeDir, ".cursor", "mcp.json");
      const targetPath = overridePath || defaultPath;

      try {
        const fileContent = await fs.readFile(targetPath, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(fileContent);
        } catch (e) {
          res.status(400).json({
            error: "Bad Request",
            message: `Invalid JSON in MCP configuration file at ${targetPath}`,
          });
          return;
        }

        const obj = parsed as Record<string, unknown>;
        const servers = (obj["servers"] || obj["mcpServers"]) as
          | Record<string, unknown>
          | undefined;

        const serverCount = servers ? Object.keys(servers).length : 0;

        if (!servers || serverCount === 0) {
          res.status(400).json({
            error: "Bad Request",
            message:
              "No valid servers found in the MCP configuration file. Expected 'servers' or 'mcpServers' with at least one entry.",
          });
          return;
        }

        res.json({
          path: targetPath,
          config: obj,
          serverCount,
        });
      } catch (readErr: any) {
        if (readErr?.code === "ENOENT") {
          res.status(404).json({
            error: "Not Found",
            message: `MCP configuration file not found at ${targetPath}`,
          });
          return;
        }
        console.error("Error reading MCP config:", readErr);
        res.status(500).json({
          error: "Internal Server Error",
          message: readErr?.message || String(readErr),
        });
      }
    } catch (error: any) {
      console.error("Unhandled error in /mcp-config route:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

app.get("/config", originValidationMiddleware, authMiddleware, (req, res) => {
  try {
    res.json({
      defaultEnvironment,
      defaultCommand: values.command,
      defaultArgs: values.args,
      defaultTransport: values.transport,
      defaultServerUrl: values["server-url"],
    });
  } catch (error) {
    console.error("Error in /config route:", error);
    res.status(500).json(error);
  }
});

// Endpoint to list available servers and their tools
app.get(
  "/servers",
  originValidationMiddleware,
  async (req, res) => {
    try {
      // Load MCP configuration
      const homeDir = os.homedir();
      const configPath = path.join(homeDir, ".cursor", "mcp.json");
      const fileContent = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(fileContent);
      const servers = config.servers || config.mcpServers;

      if (!servers) {
        res.status(404).json({
          error: "Not Found",
          message: "No MCP servers found in configuration",
        });
        return;
      }

      const serverList = Object.keys(servers).map(serverName => ({
        name: serverName,
        config: servers[serverName],
        transportType: servers[serverName].type || (servers[serverName].url ? 'http' : 'stdio')
      }));

      res.json({
        servers: serverList,
        count: serverList.length
      });
    } catch (error) {
      console.error("Error listing servers:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

// Endpoint to get tools for a specific server
app.get(
  "/servers/:serverName/tools",
  originValidationMiddleware,
  async (req, res) => {
    const { serverName } = req.params;

    try {
      // Load MCP configuration
      const homeDir = os.homedir();
      const configPath = path.join(homeDir, ".cursor", "mcp.json");
      const fileContent = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(fileContent);
      const servers = config.servers || config.mcpServers;

      if (!servers || !servers[serverName]) {
        res.status(404).json({
          error: "Not Found",
          message: `MCP server '${serverName}' not found in configuration`,
        });
        return;
      }

      const serverConfig = servers[serverName];
      console.log(`Getting tools for server '${serverName}'`);

      // Create transport based on server configuration
      let transport: Transport;
      let headerHolder: { headers: HeadersInit } | undefined;

      if (serverConfig.type === "sse" || serverConfig.url) {
        // SSE or StreamableHTTP transport
        const url = serverConfig.url || serverConfig.sseUrl;
        if (!url) {
          res.status(400).json({
            error: "Bad Request",
            message: "Server configuration missing URL for SSE/HTTP transport",
          });
          return;
        }

        const headers = getHttpHeaders(req);
        headers["Accept"] = "text/event-stream, application/json";
        headerHolder = { headers };

        if (serverConfig.type === "sse") {
          transport = new SSEClientTransport(new URL(url), {
            eventSourceInit: {
              fetch: createCustomFetch(headerHolder),
            },
            requestInit: {
              headers: headerHolder.headers,
            },
          });
        } else {
          transport = new StreamableHTTPClientTransport(new URL(url), {
            fetch: createCustomFetch(headerHolder),
          });
        }
      } else {
        // STDIO transport
        const command = serverConfig.command || "node";
        const args = serverConfig.args || [];
        const env = { ...defaultEnvironment, ...process.env, ...serverConfig.env };

        const { cmd, args: processedArgs } = findActualExecutable(command, args);
        transport = new StdioClientTransport({
          command: cmd,
          args: processedArgs,
          env,
          stderr: "pipe",
        });
      }

      // Create MCP client
      const client = new Client({
        name: "mcp-inspector-tool-lister",
        version: "1.0.0",
      });

      try {
        // Connect to server (connect() will start the transport automatically)
        await client.connect(transport);

        // Get tools list
        const toolsResponse = await client.listTools();
        const tools = toolsResponse.tools || [];

        res.json({
          success: true,
          serverName,
          tools,
          count: tools.length
        });
      } finally {
        // Always disconnect and cleanup
        try {
          await client.close();
          await transport.close();
        } catch (cleanupError) {
          console.warn("Error during cleanup:", cleanupError);
        }
      }
    } catch (error) {
      console.error("Error getting tools for server:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error),
        serverName,
      });
    }
  },
);

// Endpoint to update MCP configuration file
app.post(
  "/update-mcp-config",
  originValidationMiddleware,
  authMiddleware,
  express.json(),
  async (req, res) => {
    try {
      const { servers } = req.body;
      
      if (!servers || typeof servers !== 'object') {
        res.status(400).json({
          error: "Bad Request",
          message: "Invalid servers configuration provided"
        });
        return;
      }

      // Allow overriding the path via query param for flexibility/testing
      const overridePath = (req.query.path as string) || "";
      const homeDir = os.homedir();
      const defaultPath = path.join(homeDir, ".cursor", "mcp.json");
      const targetPath = overridePath || defaultPath;

      // Create the updated configuration
      const updatedConfig = {
        mcpServers: servers
      };

      // Write the updated configuration to file
      await fs.writeFile(targetPath, JSON.stringify(updatedConfig, null, 2), "utf8");

      res.json({
        success: true,
        message: "MCP configuration updated successfully",
        path: targetPath,
        serverCount: Object.keys(servers).length
      });
    } catch (error: any) {
      console.error("Error updating MCP config:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error)
      });
    }
  },
);

// New endpoint for on-demand tool execution
app.post(
  "/execute-tool",
  originValidationMiddleware,
  express.json(),
  async (req, res) => {
    const { serverName, toolName, toolArgs = {} } = req.body;

    if (!serverName || !toolName) {
      res.status(400).json({
        error: "Bad Request",
        message: "Both serverName and toolName are required",
      });
      return;
    }

    try {
      // Load MCP configuration
      const homeDir = os.homedir();
      const configPath = path.join(homeDir, ".cursor", "mcp.json");
      const fileContent = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(fileContent);
      const servers = config.servers || config.mcpServers;

      if (!servers || !servers[serverName]) {
        res.status(404).json({
          error: "Not Found",
          message: `MCP server '${serverName}' not found in configuration`,
        });
        return;
      }

      const serverConfig = servers[serverName];
      console.log(`Executing tool '${toolName}' on server '${serverName}'`);

      // Create transport based on server configuration
      let transport: Transport;
      let headerHolder: { headers: HeadersInit } | undefined;

      if (serverConfig.type === "sse" || serverConfig.url) {
        // SSE or StreamableHTTP transport
        const url = serverConfig.url || serverConfig.sseUrl;
        if (!url) {
          res.status(400).json({
            error: "Bad Request",
            message: "Server configuration missing URL for SSE/HTTP transport",
          });
          return;
        }

        const headers = getHttpHeaders(req);
        headers["Accept"] = "text/event-stream, application/json";
        headerHolder = { headers };

        if (serverConfig.type === "sse") {
          transport = new SSEClientTransport(new URL(url), {
            eventSourceInit: {
              fetch: createCustomFetch(headerHolder),
            },
            requestInit: {
              headers: headerHolder.headers,
            },
          });
        } else {
          transport = new StreamableHTTPClientTransport(new URL(url), {
            fetch: createCustomFetch(headerHolder),
          });
        }
      } else {
        // STDIO transport
        const command = serverConfig.command || "node";
        const args = serverConfig.args || [];
        const env = { ...defaultEnvironment, ...process.env, ...serverConfig.env };

        const { cmd, args: processedArgs } = findActualExecutable(command, args);
        transport = new StdioClientTransport({
          command: cmd,
          args: processedArgs,
          env,
          stderr: "pipe",
        });
      }

      // Create MCP client
      const client = new Client({
        name: "mcp-inspector-executor",
        version: "1.0.0",
      });

      try {
        // Connect to server (connect() will start the transport automatically)
        await client.connect(transport);

        // Execute the tool
        const result = await client.callTool({
          name: toolName,
          arguments: toolArgs,
        });

        res.json({
          success: true,
          result,
          serverName,
          toolName,
        });
      } finally {
        // Always disconnect and cleanup
        try {
          await client.close();
          await transport.close();
        } catch (cleanupError) {
          console.warn("Error during cleanup:", cleanupError);
        }
      }
    } catch (error) {
      console.error("Error executing tool:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error),
        serverName,
        toolName,
      });
    }
  },
);

// Log management endpoints
app.get(
  "/logs",
  originValidationMiddleware,
  authMiddleware,
  (req, res) => {
    try {
      const files = logger.getAvailableLogFiles();
      res.json({
        success: true,
        files,
        count: files.length,
        logsDirectory: logger.getLogsDirectory()
      });
    } catch (error) {
      logger.error("Error listing log files:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
);

app.get(
  "/logs/current",
  (req, res) => {
    try {
      const content = logger.readLogFile();
      const lines = content.split('\n').filter(line => line.trim());
      
      // Support pagination
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const totalLines = lines.length;
      const endIndex = totalLines;
      const startIndex = Math.max(0, endIndex - limit);
      
      const paginatedLines = lines.slice(startIndex, endIndex);
      const totalPages = Math.ceil(totalLines / limit);
      
      res.json({
        success: true,
        content: paginatedLines.join('\n'),
        pagination: {
          page,
          limit,
          totalLines,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1
        },
        logFile: logger.getLogFilePath()
      });
    } catch (error) {
      logger.error("Error reading current log file:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
);

app.get(
  "/logs/:filename",
  (req, res) => {
    try {
      const { filename } = req.params;
      const content = logger.readSpecificLogFile(filename);
      const lines = content.split('\n').filter(line => line.trim());
      
      // Support pagination
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      
      const paginatedLines = lines.slice(startIndex, endIndex);
      const totalLines = lines.length;
      const totalPages = Math.ceil(totalLines / limit);
      
      res.json({
        success: true,
        filename,
        content: paginatedLines.join('\n'),
        pagination: {
          page,
          limit,
          totalLines,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1
        }
      });
    } catch (error) {
      logger.error("Error reading log file:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
);

app.delete(
  "/logs/cleanup",
  originValidationMiddleware,
  authMiddleware,
  (req, res) => {
    try {
      const daysToKeep = parseInt(req.query.days as string) || 7;
      logger.clearOldLogs(daysToKeep);
      
      res.json({
        success: true,
        message: `Cleaned up log files older than ${daysToKeep} days`,
        daysToKeep
      });
    } catch (error) {
      logger.error("Error cleaning up logs:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
);

app.post(
  "/logs/test",
  originValidationMiddleware,
  authMiddleware,
  express.json(),
  (req, res) => {
    try {
      const { level = 'info', message = 'Test log message' } = req.body;
      
      switch (level) {
        case 'info':
          logger.info(message);
          break;
        case 'warn':
          logger.warn(message);
          break;
        case 'error':
          logger.error(message);
          break;
        case 'debug':
          logger.debug(message);
          break;
        default:
          logger.info(message);
      }
      
      res.json({
        success: true,
        message: `Test log message written with level: ${level}`,
        level,
        logFile: logger.getLogFilePath()
      });
    } catch (error) {
      logger.error("Error writing test log:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
);

const PORT = parseInt(
  process.env.SERVER_PORT || DEFAULT_MCP_PROXY_LISTEN_PORT,
  10,
);
const HOST = process.env.HOST || "localhost";

const server = app.listen(PORT, HOST);
server.on("listening", () => {
  logger.info(`⚙️ Proxy server listening on ${HOST}:${PORT}`);
  if (!authDisabled) {
    logger.info(
      `🔑 Session token: ${sessionToken}\n   ` +
        `Use this token to authenticate requests or set DANGEROUSLY_OMIT_AUTH=true to disable auth`,
    );
  } else {
    logger.warn(
      `⚠️  WARNING: Authentication is disabled. This is not recommended.`,
    );
  }
});
server.on("error", (err) => {
  if (err.message.includes(`EADDRINUSE`)) {
    logger.error(`❌  Proxy Server PORT IS IN USE at port ${PORT} ❌ `);
  } else {
    logger.error(err.message);
  }
  process.exit(1);
});
