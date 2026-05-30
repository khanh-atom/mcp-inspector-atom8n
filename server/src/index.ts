#!/usr/bin/env node

import cors from "cors";
import { parseArgs } from "node:util";

import nodeFetch, { Headers as NodeHeaders } from "node-fetch";

// Type-compatible wrappers for node-fetch to work with browser-style types
const fetch = nodeFetch;
const Headers = NodeHeaders;

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
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const TOML = require("@iarna/toml") as typeof import("@iarna/toml");
import { exec } from "node:child_process";
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

// Cache for execute-tool connections: reuse client+transport per serverName
type CachedExecuteToolConnection = { client: Client; transport: Transport };
const executeToolConnectionCache = new Map<
  string,
  CachedExecuteToolConnection | Promise<CachedExecuteToolConnection>
>();

// Use provided token from environment or generate a new one
const sessionToken =
  process.env.MCP_PROXY_AUTH_TOKEN || randomBytes(32).toString("hex");
const authDisabled = process.env.DANGEROUSLY_OMIT_AUTH !== "false";

// Origin validation middleware to prevent DNS rebinding attacks
const originValidationMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const origin = req.headers.origin;

  // If no origin header, allow the request (for same-origin requests)
  if (!origin) {
    next();
    return;
  }

  // // Check if ALLOWED_ORIGINS is explicitly set
  // if (process.env.ALLOWED_ORIGINS) {
  //   const allowedOrigins = process.env.ALLOWED_ORIGINS.split(",");
  //   if (!allowedOrigins.includes(origin)) {
  //     console.error(`Invalid origin: ${origin}`);
  //     res.status(403).json({
  //       error: "Forbidden - invalid origin",
  //       message:
  //         "Request blocked to prevent DNS rebinding attacks. Configure allowed origins via environment variable.",
  //     });
  //     return;
  //   }
  // } else {
  //   // Default behavior: allow any localhost origin (with any port)
  //   const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1|::1)(:\d+)?$/;
  //   if (!localhostRegex.test(origin)) {
  //     console.error(`Invalid origin: ${origin}`);
  //     res.status(403).json({
  //       error: "Forbidden - invalid origin",
  //       message:
  //         "Request blocked to prevent DNS rebinding attacks. Only localhost origins are allowed by default.",
  //     });
  //     return;
  //   }
  // }

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
 * Converts a Node.js ReadableStream to a web-compatible ReadableStream
 * This is necessary for the EventSource polyfill which expects web streams
 */
const createWebReadableStream = (nodeStream: any): ReadableStream => {
  return new ReadableStream({
    start(controller) {
      let closed = false;
      nodeStream.on("data", (chunk: any) => {
        if (!closed) {
          try {
            controller.enqueue(chunk);
          } catch {
            closed = true;
          }
        }
      });
      nodeStream.on("end", () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Controller already closed, ignore
          }
        }
      });
      nodeStream.on("error", (err: any) => {
        if (!closed) {
          closed = true;
          try {
            controller.error(err);
          } catch {
            // Controller already closed, ignore
          }
        }
      });
    },
  });
};

/**
 * Creates a `fetch` function that merges dynamic session headers with the
 * headers from the actual request, ensuring that request-specific headers like
 * `Content-Type` are preserved. For SSE requests, it also converts Node.js
 * streams to web-compatible streams.
 */
const createCustomFetch = (headerHolder: { headers: HeadersInit }) => {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
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

    // Convert Headers to a plain object for node-fetch compatibility
    const headersObject: Record<string, string> = {};
    finalHeaders.forEach((value, key) => {
      headersObject[key] = value;
    });

    // Get the response from node-fetch (cast input and init to handle type differences)
    const response = await fetch(
      input as any,
      { ...init, headers: headersObject } as any,
    );

    // Check if this is an SSE request by looking at the Accept header
    const acceptHeader = finalHeaders.get("Accept");
    const isSSE = acceptHeader?.includes("text/event-stream");

    if (isSSE && response.body) {
      // For SSE requests, we need to convert the Node.js stream to a web ReadableStream
      // because the EventSource polyfill expects web-compatible streams
      const webStream = createWebReadableStream(response.body);

      // Create a new response with the web-compatible stream
      // Convert node-fetch headers to plain object for web Response compatibility
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value: string, key: string) => {
        responseHeaders[key] = value;
      });

      return new Response(webStream, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      }) as Response;
    }

    // For non-SSE requests, return the response as-is (cast to handle type differences)
    return response as unknown as Response;
  };
};

/**
 * Parse a command-line args string into an array, preserving backslashes
 * for Windows path compatibility. Handles double-quoted and single-quoted
 * strings, but does NOT interpret backslash as an escape character.
 */
const parseArgsWindowsSafe = (argsString: string): string[] => {
  const args: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i];

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if ((ch === " " || ch === "\t") && !inDoubleQuote && !inSingleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
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
    const origArgs = parseArgsWindowsSafe(query.args as string);
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
    const upstreamUrl = query.url as string;
    const headers = getHttpHeaders(req);
    headers["Accept"] = "text/event-stream, application/json";

    // [PROXY] Auto-inject credentials if no Authorization header present
    if (!headers["Authorization"] && !headers["authorization"]) {
      console.log(
        `[createTransport:proxy] No Authorization header from client, looking up credentials for ${upstreamUrl}`,
      );
      try {
        const located = await findCredentialForServerUrl(upstreamUrl);
        if (located?.credential.access_token) {
          // Check if token is expired and auto-refresh
          const safetyMarginMs = 60_000;
          if (
            located.credential.expires_at &&
            located.credential.expires_at <= Date.now() + safetyMarginMs &&
            located.meta
          ) {
            console.log(
              "[createTransport:proxy] Token expired or expiring soon, refreshing...",
            );
            try {
              const refreshResult = await refreshCredentialToken(located.meta);
              headers["Authorization"] = `Bearer ${refreshResult.accessToken}`;
              console.log("[createTransport:proxy] Injected refreshed token");
            } catch (refreshErr) {
              // Fall back to the existing (possibly expired) token
              headers["Authorization"] =
                `Bearer ${located.credential.access_token}`;
              console.warn(
                "[createTransport:proxy] Refresh failed, using existing token:",
                refreshErr,
              );
            }
          } else {
            headers["Authorization"] =
              `Bearer ${located.credential.access_token}`;
            console.log(
              "[createTransport:proxy] Injected credential token for upstream URL",
            );
          }
        } else {
          console.log(
            "[createTransport:proxy] No matching credential found for upstream URL",
          );
        }
      } catch (error) {
        console.warn(
          "[createTransport:proxy] Credential lookup failed:",
          error,
        );
      }
    } else {
      console.log(
        "[createTransport:proxy] Client already provided Authorization header",
      );
    }

    const headerHolder = { headers };

    const transport = new StreamableHTTPClientTransport(new URL(upstreamUrl), {
      // Pass a custom fetch to inject the latest headers on each request
      fetch: createCustomFetch(headerHolder),
    });
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
      console.log(
        `[STDIO] New connection request (active transports: ${webAppTransports.size}, server transports: ${serverTransports.size})`,
      );
      const { transport: serverTransport } = await createTransport(req);
      console.log("[STDIO] Server transport (child process) started");

      const proxyFullAddress = (req.query.proxyFullAddress as string) || "";
      const prefix = proxyFullAddress || "";
      const endpoint = `${prefix}/message`;

      const webAppTransport = new SSEServerTransport(endpoint, res);
      const sessionId = webAppTransport.sessionId;
      webAppTransports.set(sessionId, webAppTransport);
      console.log(
        `[STDIO] Created SSE client transport, sessionId=${sessionId}`,
      );

      serverTransports.set(sessionId, serverTransport);
      console.log(
        `[STDIO] Registered server transport, sessionId=${sessionId} (total active: ${webAppTransports.size})`,
      );

      await webAppTransport.start();
      console.log(
        `[STDIO] SSE client transport started, sessionId=${sessionId}`,
      );

      // Clean up when SSE connection closes (client disconnect / EventSource reconnect)
      res.on("close", () => {
        console.log(
          `[STDIO] SSE response stream closed, sessionId=${sessionId} — cleaning up stale transport`,
        );
        // Close the child process transport to prevent zombie processes
        serverTransport.close().catch((err) => {
          console.error(
            `[STDIO] Error closing server transport for sessionId=${sessionId}:`,
            err,
          );
        });
        // Remove from maps so they don't accumulate
        webAppTransports.delete(sessionId);
        serverTransports.delete(sessionId);
        sessionHeaderHolders.delete(sessionId);
        console.log(
          `[STDIO] Cleaned up sessionId=${sessionId} (remaining active: ${webAppTransports.size})`,
        );
      });

      // Buffer stderr for crash reporting
      const stderrBuffer: string[] = [];

      // Monitor child process exit directly (won't be overwritten by mcpProxy)
      const childProcess = (serverTransport as any)._process;
      if (childProcess) {
        childProcess.on(
          "exit",
          (code: number | null, signal: string | null) => {
            console.log(
              `[STDIO] Child process EXITED: code=${code}, signal=${signal}, sessionId=${sessionId}`,
            );
            if (code !== null && code !== 0) {
              // Child process crashed — send fatal error to client before close cascade
              const errorMessage =
                stderrBuffer.join("\n") || `Process exited with code ${code}`;
              console.error(
                `[STDIO] Sending crash notification to client, sessionId=${sessionId}`,
              );
              // Set very long retry to prevent EventSource auto-reconnect
              try {
                res.write(`retry: 999999999\n\n`);
              } catch {
                // Response may already be ending
              }
              webAppTransport
                .send({
                  jsonrpc: "2.0",
                  method: "notifications/message",
                  params: {
                    level: "emergency",
                    logger: "proxy",
                    data: {
                      message: errorMessage,
                      type: "process_crash",
                      exitCode: code,
                    },
                  },
                })
                .catch(() => {
                  // Client already disconnected, ignore
                });
            }
          },
        );
        childProcess.on("error", (err: Error) => {
          console.error(
            `[STDIO] Child process ERROR: ${err.message}, sessionId=${sessionId}`,
          );
        });
      } else {
        console.warn(
          "[STDIO] Could not access child process for exit monitoring",
        );
      }

      (serverTransport as StdioClientTransport).stderr!.on("data", (chunk) => {
        const stderrText = chunk.toString().trim();
        stderrBuffer.push(stderrText);
        console.error(
          `[STDIO] stderr from child process (sessionId=${sessionId}): ${stderrText}`,
        );
        if (chunk.toString().includes("MODULE_NOT_FOUND")) {
          // Server command not found, remove transports
          const message = "Command not found, transports removed";
          console.error(`[STDIO] ${message}, sessionId=${sessionId}`);
          webAppTransport
            .send({
              jsonrpc: "2.0",
              method: "notifications/message",
              params: {
                level: "emergency",
                logger: "proxy",
                data: {
                  message,
                },
              },
            })
            .catch(() => {
              // Client already disconnected, ignore
            });
          webAppTransport.close();
          serverTransport.close();
          webAppTransports.delete(sessionId);
          serverTransports.delete(sessionId);
          sessionHeaderHolders.delete(sessionId);
          console.log(
            `[STDIO] Cleaned up transports for sessionId=${sessionId} (remaining active: ${webAppTransports.size})`,
          );
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
          } else if (ucMsg.includes("FATAL")) {
            level = "emergency";
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
          webAppTransport
            .send({
              jsonrpc: "2.0",
              method: "notifications/message",
              params: {
                level,
                logger: "stdio",
                data: {
                  message,
                },
              },
            })
            .catch(() => {
              // Client already disconnected, ignore
            });
        }
      });

      mcpProxy({
        transportToClient: webAppTransport,
        transportToServer: serverTransport,
      });
      console.log(
        `[STDIO] mcpProxy bridge established, sessionId=${sessionId}`,
      );
    } catch (error) {
      console.error("[STDIO] Error during connection setup:", error);
      if (error instanceof SseError && error.code === 401) {
        console.error("[STDIO] 401 Unauthorized from MCP server");
        res.status(401).json(error);
        return;
      }
      console.error("[STDIO] Error in /stdio route:", error);
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
      // Automatic fallback: if SSE returns 400, switch to StreamableHTTP
      if (
        error instanceof SseError &&
        (error.code === 400 ||
          (typeof error.message === "string" &&
            error.message.includes("Non-200 status code (400)")))
      ) {
        try {
          console.warn(
            "SSE returned 400. Falling back to StreamableHTTP transport.",
          );

          const headers = getHttpHeaders(req);
          headers["Accept"] = "text/event-stream, application/json";
          const headerHolder = { headers };
          const url = (req.query.url as string) || "";

          const serverTransport = new StreamableHTTPClientTransport(
            new URL(url),
            {
              fetch: createCustomFetch(headerHolder),
            },
          );
          await serverTransport.start();

          const proxyFullAddress = (req.query.proxyFullAddress as string) || "";
          const prefix = proxyFullAddress || "";
          const endpoint = `${prefix}/message`;

          const webAppTransport = new SSEServerTransport(endpoint, res);
          webAppTransports.set(webAppTransport.sessionId, webAppTransport);
          sessionHeaderHolders.set(webAppTransport.sessionId, headerHolder);

          await webAppTransport.start();

          mcpProxy({
            transportToClient: webAppTransport,
            transportToServer: serverTransport,
          });
          return;
        } catch (fallbackError) {
          if (!res.headersSent) {
            console.error(
              "StreamableHTTP fallback failed in /sse route:",
              fallbackError,
            );
            res.status(500).json(fallbackError);
          }
          return;
        }
      }
      if (res.headersSent) {
        console.error("Error in /sse route after headers sent:", error);
        return;
      }
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "Received 401 Unauthorized from MCP server. Authentication failure.",
        );
        res.status(401).json(error);
        return;
      }
      if (error instanceof SseError && error.code === 404) {
        console.error(
          "Received 404 not found from MCP server. Does the MCP server support SSE?",
        );
        res.status(404).json(error);
        return;
      }
      if (JSON.stringify(error).includes("ECONNREFUSED")) {
        console.error("Connection refused. Is the MCP server running?");
        res.status(500).json(error);
        return;
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
        res.status(400).json({
          error: "Bad Request",
          message: "Missing 'url' query parameter",
        });
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
              return new URL(
                `https://gist.githubusercontent.com/${user}/${id}/raw`,
              ).toString();
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
              return new URL(
                `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${filePath}`,
              ).toString();
            }
          }
          return u.toString();
        } catch (e) {
          throw new Error(
            `Invalid URL: ${String(e instanceof Error ? e.message : e)}`,
          );
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
          res
            .status(resp.status)
            .json({ error: "UpstreamError", message: text || resp.statusText });
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
            res.status(415).json({
              error: "Unsupported Media Type",
              message: "Upstream did not return JSON",
            });
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
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// Expand tilde (~) to the user's home directory, cross-platform.
// Handles ~/..., ~\... (Windows), and bare ~.
function expandTildePath(rawPath: string): string {
  const homeDir = os.homedir();
  if (rawPath === "~") return homeDir;
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(homeDir, rawPath.slice(2));
  }
  // Resolve relative paths (e.g. ./data) to absolute
  if (!path.isAbsolute(rawPath)) {
    return path.resolve(rawPath);
  }
  return rawPath;
}

// Returns the default Cursor MCP configuration from the user's home directory
// Default path: <home>/.cursor/mcp.json (cross-platform)
app.get(
  "/mcp-config",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      // Allow overriding the path via query param for flexibility/testing
      const rawOverridePath = (req.query.path as string) || "";
      const overridePath = expandTildePath(rawOverridePath);
      const defaultPath = path.join(os.homedir(), ".cursor", "mcp.json");
      const targetPath = overridePath || defaultPath;

      try {
        const fileContent = await fs.readFile(targetPath, "utf8");
        const isToml = targetPath.endsWith(".toml");
        const isJsonc = targetPath.endsWith(".jsonc");
        let parsed: unknown;
        try {
          if (isToml) {
            parsed = TOML.parse(fileContent);
          } else {
            // Strip single-line // comments and trailing commas for JSONC support
            const cleanedContent = isJsonc
              ? fileContent
                  .replace(/^\s*\/\/.*$/gm, "")
                  .replace(/,\s*([}\]])/g, "$1")
              : fileContent;
            parsed = JSON.parse(cleanedContent);
          }
        } catch (e) {
          res.status(400).json({
            error: "Bad Request",
            message: `Invalid ${isToml ? "TOML" : "JSON"} in MCP configuration file at ${targetPath}`,
          });
          return;
        }

        let obj = parsed as Record<string, unknown>;

        // Codex TOML uses [mcp_servers.<name>] sections – normalise to { mcpServers }
        if (isToml && obj["mcp_servers"] && !obj["mcpServers"]) {
          obj = { ...obj, mcpServers: obj["mcp_servers"] };
        }

        // OpenCode uses "mcp" key with a different format:
        //   { type: "local", command: ["cmd", "arg1", ...], environment: {...} }
        // Normalise to Cursor-style { command: "cmd", args: [...], env: {...} }
        if (obj["mcp"] && !obj["mcpServers"] && !obj["servers"]) {
          const mcpEntries = obj["mcp"] as Record<string, any>;
          const normalised: Record<string, any> = {};
          for (const [name, entry] of Object.entries(mcpEntries)) {
            if (entry && Array.isArray(entry.command)) {
              // OpenCode format: command is an array
              const [cmd, ...args] = entry.command as string[];
              normalised[name] = {
                command: cmd || "",
                args,
                env: entry.environment || {},
                disabled: entry.enabled === false,
              };
            } else {
              // Already in Cursor-style or unknown format, pass through
              normalised[name] = entry;
            }
          }
          obj = { ...obj, mcpServers: normalised };
        }

        const servers = (obj["servers"] || obj["mcpServers"]) as
          | Record<string, unknown>
          | undefined;

        const serverCount = servers ? Object.keys(servers).length : 0;

        res.json({
          path: targetPath,
          config: obj,
          serverCount,
        });
      } catch (readErr: any) {
        if (readErr?.code === "ENOENT") {
          // Auto-create OpenCode config file if it doesn't exist
          if (targetPath.includes("opencode")) {
            try {
              const dir = path.dirname(targetPath);
              await fs.mkdir(dir, { recursive: true });
              const defaultConfig = {
                $schema: "https://opencode.ai/config.json",
                mcp: {},
              };
              await fs.writeFile(
                targetPath,
                JSON.stringify(defaultConfig, null, 2),
                "utf8",
              );
              console.log(
                `[mcp-config] Auto-created OpenCode config at ${targetPath}`,
              );
              res.json({
                path: targetPath,
                config: { ...defaultConfig, mcpServers: {} },
                serverCount: 0,
              });
              return;
            } catch (createErr) {
              console.error(
                "[mcp-config] Failed to auto-create OpenCode config:",
                createErr,
              );
            }
          }
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
app.get("/servers", originValidationMiddleware, async (req, res) => {
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

    const serverList = Object.keys(servers).map((serverName) => ({
      name: serverName,
      config: servers[serverName],
      transportType:
        servers[serverName].type ||
        (servers[serverName].url ? "http" : "stdio"),
    }));

    res.json({
      servers: serverList,
      count: serverList.length,
    });
  } catch (error) {
    console.error("Error listing servers:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

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
        const env = {
          ...defaultEnvironment,
          ...process.env,
          ...serverConfig.env,
        };

        const { cmd, args: processedArgs } = findActualExecutable(
          command,
          args,
        );
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
          count: tools.length,
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

      console.log("[update-mcp-config] Received request");
      console.log("[update-mcp-config] req.query.path:", req.query.path);
      console.log(
        "[update-mcp-config] servers keys:",
        servers ? Object.keys(servers) : "null/undefined",
      );

      if (!servers || typeof servers !== "object") {
        console.error("[update-mcp-config] Invalid servers configuration");
        res.status(400).json({
          error: "Bad Request",
          message: "Invalid servers configuration provided",
        });
        return;
      }

      // Allow overriding the path via query param for flexibility/testing
      const rawOverridePath = (req.query.path as string) || "";
      const overridePath = expandTildePath(rawOverridePath);
      const defaultPath = path.join(os.homedir(), ".cursor", "mcp.json");
      const targetPath = overridePath || defaultPath;

      console.log("[update-mcp-config] rawOverridePath:", rawOverridePath);
      console.log("[update-mcp-config] overridePath:", overridePath);
      console.log("[update-mcp-config] targetPath:", targetPath);

      // Create the updated configuration
      const isToml = targetPath.endsWith(".toml");

      console.log("[update-mcp-config] Writing to:", targetPath);

      if (isToml) {
        // For TOML files (Codex), read existing config to preserve non-MCP settings
        let existingConfig: Record<string, unknown> = {};
        try {
          const existingContent = await fs.readFile(targetPath, "utf8");
          existingConfig = TOML.parse(existingContent) as Record<
            string,
            unknown
          >;
        } catch {
          // File may not exist yet, start fresh
        }
        existingConfig["mcp_servers"] = servers;

        // For Codex TOML: generate [mcp_servers.<name>.tools.<tool>] with
        // approval_mode = "approve" for each n8n workflow file path.
        const N8N_KEY = "n8n-workflow-mcp";
        const N8N_PREFIX_LEN = 3; // ["exec", "n8n-atom-cli", "mcp"]
        const mcp = existingConfig["mcp_servers"] as Record<string, any>;
        if (mcp[N8N_KEY]) {
          const args: string[] = Array.isArray(mcp[N8N_KEY].args)
            ? mcp[N8N_KEY].args
            : [];
          const filePaths = args.slice(N8N_PREFIX_LEN);
          // Remove any stale tools object sent by the client, then
          // regenerate purely from the current file paths so that
          // uninstalled workflows lose their approval_mode entry.
          delete mcp[N8N_KEY].tools;

          if (filePaths.length > 0) {
            const tools: Record<string, { approval_mode: string }> = {};
            for (const fp of filePaths) {
              // Derive tool name from filename: strip .n8n, replace - with _
              const base = path.basename(fp).replace(/\.n8n$/, "");
              const toolName = base.replace(/-/g, "_");
              if (toolName) {
                tools[toolName] = { approval_mode: "approve" };
              }
            }
            mcp[N8N_KEY].tools = tools;
          }
        }

        const tomlContent = TOML.stringify(existingConfig as any);
        console.log("[update-mcp-config] TOML Config:", tomlContent);
        await fs.writeFile(targetPath, tomlContent, "utf8");
      } else {
        // OpenCode uses "mcp" key; detect by reading existing file or path pattern
        const isOpenCode = targetPath.includes("opencode");
        let updatedConfig: Record<string, unknown>;

        if (isOpenCode) {
          // Preserve existing OpenCode config structure, only update the "mcp" key
          let existingConfig: Record<string, unknown> = {};
          try {
            const existingContent = await fs.readFile(targetPath, "utf8");
            const cleanedContent = existingContent
              .replace(/^\s*\/\/.*$/gm, "")
              .replace(/,\s*([}\]])/g, "$1");
            existingConfig = JSON.parse(cleanedContent) as Record<
              string,
              unknown
            >;
          } catch {
            // File may not exist yet, start fresh
          }
          // Convert Cursor-style servers to OpenCode format:
          //   { type: "local", command: ["cmd", ...args], environment: {...}, enabled: true }
          const openCodeServers: Record<string, any> = {};
          for (const [name, entry] of Object.entries(servers) as [
            string,
            any,
          ][]) {
            if (entry && typeof entry.command === "string") {
              const cmdArray = [
                entry.command,
                ...(Array.isArray(entry.args) ? entry.args : []),
              ];
              openCodeServers[name] = {
                type: "local",
                command: cmdArray,
                enabled: !entry.disabled,
                ...(entry.env && Object.keys(entry.env).length > 0
                  ? { environment: entry.env }
                  : {}),
              };
            } else {
              // Already in OpenCode format or unknown, pass through
              openCodeServers[name] = entry;
            }
          }
          existingConfig["mcp"] = openCodeServers;
          updatedConfig = existingConfig;
        } else {
          updatedConfig = { mcpServers: servers };
        }

        console.log(
          "[update-mcp-config] Config:",
          JSON.stringify(updatedConfig, null, 2),
        );
        // Write the updated configuration to file
        await fs.writeFile(
          targetPath,
          JSON.stringify(updatedConfig, null, 2),
          "utf8",
        );
      }

      console.log("[update-mcp-config] Write successful");

      res.json({
        success: true,
        message: "MCP configuration updated successfully",
        path: targetPath,
        serverCount: Object.keys(servers).length,
      });
    } catch (error: any) {
      console.error("[update-mcp-config] Error:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// ── Credential Token Refresh Helpers ─────────────────────────────────────────
// Extracted from /credentials/refresh so it can be reused by /execute-tool.
const DEFAULT_CREDENTIALS_FOLDER = "./data";
const CREDENTIALS_STATE_FILE = "state.json";
let activeCredentialsFolderPath =
  process.env.MCP_CREDENTIALS_FOLDER || DEFAULT_CREDENTIALS_FOLDER;

function setActiveCredentialsFolderPath(rawPath: string, reason: string): void {
  if (!rawPath) return;
  activeCredentialsFolderPath = rawPath;
  logger.info(
    `[credentials:active] Active credentials folder set to ${rawPath} (${reason})`,
  );
}

function getEffectiveCredentialsFolderPath(folderPath?: string): string {
  return (
    folderPath || activeCredentialsFolderPath || DEFAULT_CREDENTIALS_FOLDER
  );
}

interface CredentialMeta {
  folderPath: string;
  sourceFile: string;
  credentialKey: string;
}

interface CredentialRecord {
  server_name?: string;
  server_url?: string;
  client_id?: string;
  access_token?: string;
  expires_at?: number;
  refresh_token?: string;
  scopes?: string[];
  _sourceFile?: string;
  _credentialKey?: string;
}

interface RefreshResult {
  accessToken: string;
  expiresAt: number;
  expiresInMs: number;
}

interface LocatedCredential {
  meta: CredentialMeta;
  credential: CredentialRecord;
}

function credentialsStatePath(folderPath?: string): string {
  return path.join(
    path.resolve(
      expandTildePath(getEffectiveCredentialsFolderPath(folderPath)),
    ),
    CREDENTIALS_STATE_FILE,
  );
}

function legacyEnabledCredentialsStatePath(folderPath?: string): string {
  return path.join(
    path.resolve(
      expandTildePath(getEffectiveCredentialsFolderPath(folderPath)),
    ),
    ".enabled-credentials.json",
  );
}

function getEnabledCredentialKeysFromState(parsed: unknown): string[] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const state = parsed as {
    enabledCredentialKeys?: unknown;
    credentials?: { enabledCredentialKeys?: unknown };
  };
  const keys =
    state.credentials?.enabledCredentialKeys ?? state.enabledCredentialKeys;
  if (!Array.isArray(keys)) return null;
  return keys.filter(
    (value: unknown): value is string => typeof value === "string",
  );
}

async function readPersistedEnabledCredentialKeys(
  folderPath?: string,
): Promise<string[] | null> {
  const statePath = credentialsStatePath(folderPath);
  try {
    const fileContent = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(fileContent);
    const enabledKeys = getEnabledCredentialKeysFromState(parsed);
    if (!enabledKeys) {
      logger.warn(
        `[credentials:enabled] Invalid enabled state file shape: ${statePath}`,
      );
      return null;
    }
    return enabledKeys;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      logger.warn(
        `[credentials:enabled] Failed to read enabled state file ${statePath}:`,
        error,
      );
      return null;
    }
  }

  const legacyStatePath = legacyEnabledCredentialsStatePath(folderPath);
  try {
    const fileContent = await fs.readFile(legacyStatePath, "utf8");
    const parsed = JSON.parse(fileContent);
    const enabledKeys = getEnabledCredentialKeysFromState(parsed);
    if (!enabledKeys) {
      logger.warn(
        `[credentials:enabled] Invalid legacy enabled state file shape: ${legacyStatePath}`,
      );
      return null;
    }
    logger.info(
      `[credentials:enabled] Loaded enabled credential state from legacy file ${legacyStatePath}`,
    );
    return enabledKeys;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      logger.warn(
        `[credentials:enabled] Failed to read legacy enabled state file ${legacyStatePath}:`,
        error,
      );
    }
    return null;
  }
}

async function writePersistedEnabledCredentialKeys(
  folderPath: string | undefined,
  enabledCredentialKeys: string[],
): Promise<void> {
  const folder = path.resolve(
    expandTildePath(getEffectiveCredentialsFolderPath(folderPath)),
  );
  await fs.mkdir(folder, { recursive: true });
  const statePath = credentialsStatePath(folder);
  let state: Record<string, any> = {};
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      logger.warn(
        `[credentials:enabled] Replacing unreadable state file ${statePath}:`,
        error,
      );
    }
  }

  state.credentials = {
    ...(state.credentials || {}),
    enabledCredentialKeys,
    updatedAt: new Date().toISOString(),
  };
  state.updatedAt = new Date().toISOString();

  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  logger.info(
    `[credentials:enabled] Persisted ${enabledCredentialKeys.length} enabled credential key(s) to ${statePath}`,
  );
}

function credentialFilePath(meta: CredentialMeta): string {
  if (
    !meta.sourceFile ||
    meta.sourceFile.includes("/") ||
    meta.sourceFile.includes("\\")
  ) {
    throw new Error(`Invalid credential source file: ${meta.sourceFile}`);
  }

  const folder = path.resolve(expandTildePath(meta.folderPath));
  const filePath = path.resolve(folder, meta.sourceFile);
  if (!filePath.startsWith(`${folder}${path.sep}`)) {
    throw new Error(
      `Credential source file is outside folder: ${meta.sourceFile}`,
    );
  }
  return filePath;
}

async function readCredentialFile(
  meta: CredentialMeta,
): Promise<Record<string, CredentialRecord>> {
  const filePath = credentialFilePath(meta);
  try {
    const fileContent = await fs.readFile(filePath, "utf8");
    return JSON.parse(fileContent);
  } catch (readErr: any) {
    throw new Error(
      `Credentials file not found or invalid: ${filePath} — ${readErr?.message}`,
    );
  }
}

async function readCredentialByMeta(
  meta: CredentialMeta,
): Promise<LocatedCredential> {
  const credentials = await readCredentialFile(meta);
  const credential = credentials[meta.credentialKey];
  if (!credential) {
    throw new Error(
      `Credential key '${meta.credentialKey}' not found in ${meta.sourceFile}`,
    );
  }

  return { meta, credential };
}

function normalizeServerUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value.trim());
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

const CREDENTIAL_ID_PREFIX = "credential:";

function createCredentialIdentity(
  sourceFile: string,
  credentialKey: string,
): string {
  return `${CREDENTIAL_ID_PREFIX}${encodeURIComponent(sourceFile)}:${encodeURIComponent(credentialKey)}`;
}

function isCredentialAllowedByEnabledState(
  allowedCredentialKeys: Set<string> | null,
  sourceFile: string,
  credentialKey: string,
): boolean {
  if (!allowedCredentialKeys) return true;
  return (
    allowedCredentialKeys.has(credentialKey) ||
    allowedCredentialKeys.has(
      createCredentialIdentity(sourceFile, credentialKey),
    )
  );
}

function getServerConfigUrl(
  serverConfig: Record<string, unknown>,
): string | null {
  return normalizeServerUrl(serverConfig.url || serverConfig.sseUrl);
}

async function findCredentialForServerUrl(
  serverUrl: string | null,
  folderPath?: string,
  accessToken?: string,
  enabledCredentialKeys?: string[],
): Promise<LocatedCredential | null> {
  if (!serverUrl) {
    logger.info("[credentials:lookup] Skipped: no server URL to match");
    return null;
  }
  const effectiveFolderPath = getEffectiveCredentialsFolderPath(folderPath);
  const persistedEnabledKeys =
    enabledCredentialKeys ??
    (await readPersistedEnabledCredentialKeys(effectiveFolderPath));
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const allowedCredentialKeys = persistedEnabledKeys
    ? new Set(persistedEnabledKeys)
    : null;
  let bestMatch: (LocatedCredential & { score: number }) | null = null;

  logger.info(
    `[credentials:lookup] Starting lookup serverUrl=${serverUrl} normalized=${normalizedServerUrl} folderPath=${effectiveFolderPath} enabledKeys=${
      persistedEnabledKeys
        ? persistedEnabledKeys.length
        : "<all; no state file>"
    } source=${
      enabledCredentialKeys
        ? "request"
        : persistedEnabledKeys
          ? "persisted"
          : "default-all"
    } hasRequestAccessToken=${Boolean(accessToken)}`,
  );

  for (const candidateFolder of [effectiveFolderPath]) {
    const folder = path.resolve(expandTildePath(candidateFolder));
    let jsonFiles: string[];

    try {
      const stat = await fs.stat(folder);
      if (!stat.isDirectory()) {
        logger.warn(
          `[credentials:lookup] Skipping ${folder}: path is not a directory`,
        );
        continue;
      }
      jsonFiles = (await fs.readdir(folder)).filter(
        (fileName) =>
          fileName.endsWith(".json") &&
          !fileName.startsWith(".") &&
          fileName !== CREDENTIALS_STATE_FILE,
      );
      logger.info(
        `[credentials:lookup] Folder ${folder} has ${jsonFiles.length} JSON file(s)`,
      );
    } catch (error) {
      logger.warn(
        `[credentials:lookup] Unable to read credential folder ${folder}:`,
        error,
      );
      continue;
    }

    for (const sourceFile of jsonFiles) {
      const metaBase = {
        folderPath: candidateFolder,
        sourceFile,
        credentialKey: "",
      };

      let credentials: Record<string, CredentialRecord>;
      try {
        credentials = await readCredentialFile(metaBase);
      } catch (error) {
        logger.warn(
          `[credentials:lookup] Skipping invalid credential file ${sourceFile}:`,
          error,
        );
        continue;
      }

      for (const [credentialKey, credential] of Object.entries(credentials)) {
        if (
          !isCredentialAllowedByEnabledState(
            allowedCredentialKeys,
            sourceFile,
            credentialKey,
          )
        ) {
          logger.info(
            `[credentials:lookup] Skipping key '${credentialKey}' from ${sourceFile}: not enabled for this request`,
          );
          continue;
        }

        const credentialServerUrl = normalizeServerUrl(credential.server_url);
        if (credentialServerUrl !== normalizedServerUrl) {
          logger.info(
            `[credentials:lookup] Skipping key '${credentialKey}' from ${sourceFile}: server URL mismatch credential=${credentialServerUrl} request=${normalizedServerUrl}`,
          );
          continue;
        }

        const score =
          (accessToken && credential.access_token === accessToken ? 100 : 0) +
          (credential.refresh_token ? 10 : 0) +
          (credential.access_token ? 1 : 0);
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = {
            meta: { ...metaBase, credentialKey },
            credential,
            score,
          };
        }
      }
    }
  }

  if (bestMatch) {
    logger.info(
      `[credentials:lookup] Matched credential '${bestMatch.meta.credentialKey}' in ${bestMatch.meta.sourceFile} for ${serverUrl}`,
    );
  } else {
    logger.info(
      `[credentials:lookup] No credential matched for ${serverUrl}. Enabled keys: ${
        persistedEnabledKeys
          ? persistedEnabledKeys.join(", ") || "<none>"
          : "<all>"
      }`,
    );
  }

  return bestMatch;
}

async function refreshCredentialToken(
  meta: CredentialMeta,
): Promise<RefreshResult> {
  const filePath = credentialFilePath(meta);
  logger.info(
    `[credentials:refreshHelper] Refreshing token for key '${meta.credentialKey}' in ${filePath}`,
  );

  const credentials = await readCredentialFile(meta);
  const cred = credentials[meta.credentialKey];
  if (!cred) {
    throw new Error(
      `Credential key '${meta.credentialKey}' not found in ${meta.sourceFile}`,
    );
  }

  if (!cred.refresh_token || !cred.client_id || !cred.server_url) {
    throw new Error(
      `Credential '${meta.credentialKey}' missing refresh_token, client_id, or server_url`,
    );
  }

  // Derive token endpoint from server URL
  const serverUrl = new URL(cred.server_url);
  const apiHost = serverUrl.hostname.replace(/^mcp\./, "api.");
  const tokenUrl = `https://${apiHost}/oauth2/v1/token`;

  logger.info(
    `[credentials:refreshHelper] Token refresh URL: ${tokenUrl} for server: ${cred.server_name || meta.credentialKey}`,
  );

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cred.refresh_token,
    client_id: cred.client_id,
  });

  const tokenResp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    throw new Error(`Token refresh failed (${tokenResp.status}): ${text}`);
  }

  const data = (await tokenResp.json()) as any;
  if (!data.access_token) {
    throw new Error("Token refresh response did not include access_token");
  }
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

  // Update credential in memory
  cred.access_token = data.access_token;
  cred.refresh_token = data.refresh_token ?? cred.refresh_token;
  cred.expires_at = expiresAt;
  credentials[meta.credentialKey] = cred;

  // Write back to the specific file
  await fs.writeFile(filePath, JSON.stringify(credentials, null, 4), "utf8");

  logger.info(
    `[credentials:refreshHelper] Token refreshed & saved for '${meta.credentialKey}' in ${meta.sourceFile}. New expiry: ${new Date(cred.expires_at).toISOString()}`,
  );

  return {
    accessToken: data.access_token,
    expiresAt,
    expiresInMs: expiresAt - Date.now(),
  };
}

/** Check whether an error message indicates a 401 Unauthorized from the upstream server */
function isUnauthorizedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  // Match patterns like "HTTP 401", "(401)", "401 Unauthorized", "Unauthorized"
  return /\b401\b/i.test(msg) || /\bUnauthorized\b/i.test(msg);
}

// Helpers for execute-tool connection cache
async function createExecuteToolConnection(
  serverConfig: Record<string, unknown>,
  req: express.Request,
  accessToken?: string,
): Promise<CachedExecuteToolConnection> {
  let transport: Transport;
  let headerHolder: { headers: HeadersInit } | undefined;

  if (serverConfig.type === "sse" || serverConfig.url) {
    const url = serverConfig.url || serverConfig.sseUrl;
    if (!url || typeof url !== "string") {
      throw new Error(
        "Server configuration missing URL for SSE/HTTP transport",
      );
    }
    const headers = getHttpHeaders(req);
    headers["Accept"] = "text/event-stream, application/json";
    // [CREDENTIALS] Inject credential access_token as Authorization header
    if (accessToken) {
      logger.info(
        `[execute-tool:credentials] Injecting Authorization header for URL: ${url}`,
      );
      headers["Authorization"] = `Bearer ${accessToken}`;
    }
    headerHolder = { headers };
    if (serverConfig.type === "sse") {
      transport = new SSEClientTransport(new URL(url), {
        eventSourceInit: { fetch: createCustomFetch(headerHolder) },
        requestInit: { headers: headerHolder.headers },
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(url), {
        fetch: createCustomFetch(headerHolder),
      });
    }
  } else {
    const command = (serverConfig.command as string) || "node";
    const args = (serverConfig.args as string[]) || [];
    const env = {
      ...defaultEnvironment,
      ...process.env,
      ...(serverConfig.env as Record<string, string>),
    };
    const { cmd, args: processedArgs } = findActualExecutable(command, args);
    transport = new StdioClientTransport({
      command: cmd,
      args: processedArgs,
      env,
      stderr: "pipe",
    });
  }
  const client = new Client({
    name: "mcp-inspector-executor",
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, transport };
}

function executeToolScopedCacheKey(
  cacheKey: string,
  accessToken?: string,
): string {
  return accessToken ? `${cacheKey}:credentialed` : `${cacheKey}:anonymous`;
}

async function getOrCreateExecuteToolConnection(
  cacheKey: string,
  serverConfig: Record<string, unknown>,
  req: express.Request,
  accessToken?: string,
): Promise<CachedExecuteToolConnection> {
  const scopedCacheKey = executeToolScopedCacheKey(cacheKey, accessToken);

  // [CREDENTIALS] When an access token is provided, skip the cache to ensure fresh headers
  if (accessToken) {
    logger.info(
      `[execute-tool:credentials] Bypassing credentialed cache for cacheKey='${cacheKey}' (credential token provided)`,
    );
    await evictExecuteToolConnection(scopedCacheKey);
    const promise = createExecuteToolConnection(serverConfig, req, accessToken);
    executeToolConnectionCache.set(scopedCacheKey, promise);
    try {
      const result = await promise;
      if (executeToolConnectionCache.get(scopedCacheKey) === promise) {
        executeToolConnectionCache.set(scopedCacheKey, result);
      }
      return result;
    } catch (err) {
      if (executeToolConnectionCache.get(scopedCacheKey) === promise) {
        executeToolConnectionCache.delete(scopedCacheKey);
      }
      throw err;
    }
  }
  const entry = executeToolConnectionCache.get(scopedCacheKey);
  if (entry && "client" in entry) return entry;
  if (entry instanceof Promise) {
    try {
      return await entry;
    } catch {
      executeToolConnectionCache.delete(scopedCacheKey);
    }
  }
  const promise = createExecuteToolConnection(serverConfig, req);
  executeToolConnectionCache.set(scopedCacheKey, promise);
  try {
    const result = await promise;
    if (executeToolConnectionCache.get(scopedCacheKey) === promise) {
      executeToolConnectionCache.set(scopedCacheKey, result);
    }
    return result;
  } catch (err) {
    if (executeToolConnectionCache.get(scopedCacheKey) === promise) {
      executeToolConnectionCache.delete(scopedCacheKey);
    }
    throw err;
  }
}

async function evictExecuteToolConnection(cacheKey: string): Promise<void> {
  const entry = executeToolConnectionCache.get(cacheKey);
  executeToolConnectionCache.delete(cacheKey);
  if (entry && "client" in entry) {
    try {
      await entry.client.close();
      await entry.transport.close();
    } catch (cleanupError) {
      console.warn("Error during execute-tool cache eviction:", cleanupError);
    }
  }
}

async function evictAllExecuteToolConnections(reason: string): Promise<void> {
  const cacheKeys = [...executeToolConnectionCache.keys()];
  if (cacheKeys.length === 0) return;

  logger.info(
    `[execute-tool:cache] Evicting ${cacheKeys.length} cached connection(s): ${reason}`,
  );
  await Promise.all(
    cacheKeys.map((cacheKey) => evictExecuteToolConnection(cacheKey)),
  );
}

async function evictExecuteToolConnectionVariants(
  cacheKey: string,
): Promise<void> {
  await Promise.all([
    evictExecuteToolConnection(executeToolScopedCacheKey(cacheKey)),
    evictExecuteToolConnection(executeToolScopedCacheKey(cacheKey, "token")),
  ]);
}

// [PROXY] List tools from a credential-authenticated MCP server
// Used by the Proxy popup in CredentialsTab to show available tools
app.post(
  "/credential-server-tools",
  originValidationMiddleware,
  express.json(),
  async (req, res) => {
    const { serverUrl, accessToken, credentialMeta, credentialsFolderPath } =
      req.body as {
        serverUrl?: string;
        accessToken?: string;
        credentialMeta?: CredentialMeta;
        credentialsFolderPath?: string;
      };

    console.log("[credential-server-tools] Request received", {
      serverUrl,
      hasAccessToken: Boolean(accessToken),
      hasCredentialMeta: Boolean(credentialMeta),
    });

    if (!serverUrl) {
      console.warn("[credential-server-tools] Missing serverUrl");
      res.status(400).json({
        error: "Bad Request",
        message: "serverUrl is required",
      });
      return;
    }

    let effectiveAccessToken = accessToken;

    // [PROXY] Always check credentialMeta for a fresher token, even if accessToken was provided
    if (credentialMeta) {
      console.log(
        "[credential-server-tools] Checking credential via meta for freshest token",
        credentialMeta,
      );
      try {
        const located = await readCredentialByMeta(credentialMeta);

        // Auto-refresh if expired (or about to expire within 60s)
        const safetyMarginMs = 60_000;
        if (
          located.credential.expires_at &&
          located.credential.expires_at <= Date.now() + safetyMarginMs
        ) {
          console.log(
            "[credential-server-tools] Token expired or expiring soon, refreshing...",
          );
          const refreshResult = await refreshCredentialToken(credentialMeta);
          effectiveAccessToken = refreshResult.accessToken;
          console.log(
            "[credential-server-tools] Token refreshed successfully, new expiry:",
            new Date(refreshResult.expiresAt).toISOString(),
          );
        } else if (located.credential.access_token) {
          // Use the on-disk token (may be newer than the one the client sent)
          effectiveAccessToken = located.credential.access_token;
          console.log(
            "[credential-server-tools] Using on-disk token (not expired)",
          );
        }
      } catch (error) {
        console.warn(
          "[credential-server-tools] Failed to read/refresh credential via meta:",
          error,
        );
      }
    }

    // [PROXY] If still no access token, try finding one by server URL
    if (!effectiveAccessToken) {
      console.log(
        "[credential-server-tools] Attempting credential lookup by server URL",
      );
      try {
        const located = await findCredentialForServerUrl(
          serverUrl,
          credentialsFolderPath,
        );
        if (located?.credential.access_token) {
          effectiveAccessToken = located.credential.access_token;
          console.log(
            "[credential-server-tools] Found credential by URL match",
          );
        }
      } catch (error) {
        console.warn(
          "[credential-server-tools] Credential lookup by URL failed:",
          error,
        );
      }
    }

    // [PROXY] Helper: attempt to connect and list tools with the given token
    const attemptListTools = async (
      token: string | undefined,
    ): Promise<{
      success: boolean;
      tools?: any[];
      error?: unknown;
      is401?: boolean;
    }> => {
      let transport: Transport | null = null;
      let client: Client | null = null;

      try {
        const headers: Record<string, string> = {
          Accept: "text/event-stream, application/json",
        };

        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
          console.log(
            "[credential-server-tools] Injecting Authorization header",
          );
        } else {
          console.log(
            "[credential-server-tools] No access token available, connecting without auth",
          );
        }

        const headerHolder = { headers };
        console.log(`[credential-server-tools] Connecting to ${serverUrl}`);

        transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
          fetch: createCustomFetch(headerHolder),
        });

        client = new Client({
          name: "mcp-inspector-proxy-tool-lister",
          version: "1.0.0",
        });

        await client.connect(transport);
        console.log("[credential-server-tools] Connected successfully");

        const toolsResponse = await client.listTools();
        const tools = toolsResponse.tools || [];
        console.log(`[credential-server-tools] Listed ${tools.length} tool(s)`);

        return { success: true, tools };
      } catch (error) {
        const is401 = isUnauthorizedError(error);
        console.error(
          `[credential-server-tools] Error listing tools (is401=${is401}):`,
          error,
        );
        return { success: false, error, is401 };
      } finally {
        try {
          if (client) await client.close();
          if (transport) await transport.close();
          console.log("[credential-server-tools] Connection cleaned up");
        } catch (cleanupError) {
          console.warn(
            "[credential-server-tools] Cleanup error:",
            cleanupError,
          );
        }
      }
    };

    // [PROXY] First attempt
    let result = await attemptListTools(effectiveAccessToken);

    // [PROXY] If 401 and we have credentialMeta, try refreshing token and retrying once
    if (!result.success && result.is401 && credentialMeta) {
      console.log(
        "[credential-server-tools] Got 401, attempting token refresh and retry...",
      );
      try {
        const refreshResult = await refreshCredentialToken(credentialMeta);
        effectiveAccessToken = refreshResult.accessToken;
        console.log(
          "[credential-server-tools] Token refreshed for retry, new expiry:",
          new Date(refreshResult.expiresAt).toISOString(),
        );

        result = await attemptListTools(effectiveAccessToken);
      } catch (refreshError) {
        console.error(
          "[credential-server-tools] Token refresh for retry failed:",
          refreshError,
        );
      }
    }

    if (result.success) {
      res.json({
        success: true,
        serverUrl,
        tools: result.tools,
        count: result.tools?.length ?? 0,
      });
    } else {
      res.status(500).json({
        error: "Internal Server Error",
        message:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
        serverUrl,
      });
    }
  },
);

// New endpoint for on-demand tool execution (connections cached by serverName)
// Supports automatic token refresh on 401 Unauthorized when credentials can be resolved.
app.post(
  "/execute-tool",
  originValidationMiddleware,
  express.json(),
  async (req, res) => {
    const {
      serverName,
      server,
      toolName,
      toolArgs = {},
      credentials,
      credentialMeta,
      credentialsFolderPath,
      enabledCredentialKeys,
    }: {
      serverName?: string;
      server?: Record<string, unknown>;
      toolName?: string;
      toolArgs?: Record<string, unknown>;
      credentials?: { access_token?: string };
      credentialMeta?: CredentialMeta;
      credentialsFolderPath?: string;
      enabledCredentialKeys?: string[];
    } = req.body;

    // [CREDENTIALS] Log if credentials are being provided
    logger.info(
      `[execute-tool:request] Body keys: ${Object.keys(req.body || {}).join(", ") || "<none>"}`,
    );
    logger.info(
      `[execute-tool:request] Credential fields present: credentials=${Boolean(credentials)}, credentialMeta=${Boolean(credentialMeta)}, credentialsFolderPath=${Boolean(credentialsFolderPath)}, enabledCredentialKeys=${
        Array.isArray(enabledCredentialKeys)
          ? `${enabledCredentialKeys.length} key(s)`
          : "<missing>"
      }`,
    );
    if (credentials?.access_token) {
      logger.info(
        `[execute-tool:credentials] Credentials provided for toolName=${toolName || "<missing>"}, token length=${credentials.access_token.length}`,
      );
    }
    if (credentialMeta) {
      logger.info(
        `[execute-tool:credentials] credentialMeta provided: key=${credentialMeta.credentialKey}, file=${credentialMeta.sourceFile}`,
      );
    }
    if (credentialsFolderPath) {
      logger.info(
        `[execute-tool:credentials] credentialsFolderPath provided: ${credentialsFolderPath}`,
      );
    }
    if (enabledCredentialKeys) {
      logger.info(
        `[execute-tool:credentials] enabledCredentialKeys provided: ${enabledCredentialKeys.length} (${enabledCredentialKeys.join(", ") || "<empty>"})`,
      );
    }

    logger.info(
      `[execute-tool] Request received toolName=${toolName || "<missing>"} serverName=${serverName || "<none>"} hasInlineServer=${Boolean(server)}`,
    );

    if (!toolName || (!serverName && !server)) {
      logger.warn(
        "[execute-tool] Validation failed: missing toolName or both server/serverName",
      );
      res.status(400).json({
        error: "Bad Request",
        message: "toolName and either serverName or server are required",
      });
      return;
    }
    if (server && (typeof server !== "object" || Array.isArray(server))) {
      logger.warn("[execute-tool] Validation failed: server must be an object");
      res.status(400).json({
        error: "Bad Request",
        message: "server must be a JSON object",
      });
      return;
    }

    try {
      let resolvedServerConfig: Record<string, unknown>;
      let cacheKey: string;
      let resolvedServerName: string | undefined = serverName;

      if (server) {
        resolvedServerConfig = server;
        cacheKey = `inline:${JSON.stringify(server)}`;
        logger.info("[execute-tool] Using inline server configuration");
      } else {
        const homeDir = os.homedir();
        const configPath = path.join(homeDir, ".cursor", "mcp.json");
        const fileContent = await fs.readFile(configPath, "utf8");
        const config = JSON.parse(fileContent);
        const servers = config.servers || config.mcpServers;

        if (!resolvedServerName || !servers || !servers[resolvedServerName]) {
          logger.warn(
            `[execute-tool] Server not found in configuration: ${resolvedServerName || "<missing>"}`,
          );
          res.status(404).json({
            error: "Not Found",
            message: `MCP server '${resolvedServerName}' not found in configuration`,
          });
          return;
        }

        resolvedServerConfig = servers[resolvedServerName];
        cacheKey = `named:${resolvedServerName}`;
        logger.info(
          `[execute-tool] Using configured server '${resolvedServerName}'`,
        );
      }

      logger.info(
        `[execute-tool] Executing tool '${toolName}' via cacheKey='${cacheKey}'`,
      );
      logger.info(
        `[execute-tool] Resolved server URL for credential lookup: ${getServerConfigUrl(resolvedServerConfig) || "<none>"}`,
      );

      let locatedCredential: LocatedCredential | null = null;
      let effectiveCredentialMeta = credentialMeta;
      if (credentialMeta) {
        try {
          locatedCredential = await readCredentialByMeta(credentialMeta);
        } catch (error) {
          logger.warn(
            "[execute-tool:credentials] Unable to read credentialMeta before execution:",
            error,
          );
        }
      } else {
        locatedCredential = await findCredentialForServerUrl(
          getServerConfigUrl(resolvedServerConfig),
          credentialsFolderPath,
          credentials?.access_token,
          enabledCredentialKeys,
        );
        effectiveCredentialMeta = locatedCredential?.meta;
      }
      logger.info(
        `[execute-tool:credentials] Lookup result: located=${Boolean(locatedCredential)}, effectiveMeta=${
          effectiveCredentialMeta
            ? `${effectiveCredentialMeta.credentialKey} (${effectiveCredentialMeta.sourceFile})`
            : "<none>"
        }`,
      );

      // [CREDENTIALS] Prefer an explicit request token, then the stored token.
      let currentAccessToken =
        credentials?.access_token || locatedCredential?.credential.access_token;
      let tokenRefreshed = false;
      logger.info(
        `[execute-tool:credentials] Access token source before refresh: ${
          credentials?.access_token
            ? "request.credentials"
            : locatedCredential?.credential.access_token
              ? "stored credential"
              : "<none>"
        }`,
      );

      if (!currentAccessToken && effectiveCredentialMeta) {
        logger.info(
          "[execute-tool:credentials] No access token supplied; refreshing matched credential before execution",
        );
        const refreshResult = await refreshCredentialToken(
          effectiveCredentialMeta,
        );
        currentAccessToken = refreshResult.accessToken;
        tokenRefreshed = true;
      }

      const runTool = async (accessToken?: string) => {
        const scopedCacheKey = executeToolScopedCacheKey(cacheKey, accessToken);
        try {
          const { client } = await getOrCreateExecuteToolConnection(
            cacheKey,
            resolvedServerConfig,
            req,
            accessToken,
          );
          return await client.callTool({
            name: toolName,
            arguments: toolArgs,
          });
        } catch (toolError) {
          logger.warn(
            `[execute-tool] Tool '${toolName}' failed; evicting cache key '${scopedCacheKey}'`,
          );
          await evictExecuteToolConnection(scopedCacheKey);
          throw toolError;
        }
      };

      try {
        const result = await runTool(currentAccessToken);
        logger.info(`[execute-tool] Tool '${toolName}' completed successfully`);
        res.json({
          success: true,
          result,
          toolName,
          ...(tokenRefreshed ? { tokenRefreshed } : {}),
          ...(resolvedServerName ? { serverName: resolvedServerName } : {}),
          ...(server ? { server } : {}),
        });
        return;
      } catch (executeError) {
        // ── Auto-refresh on 401 Unauthorized ────────────────────────────
        // If the MCP connection or tool call failed with a 401 and we have
        // credential metadata, refresh and retry once.
        if (isUnauthorizedError(executeError) && effectiveCredentialMeta) {
          logger.info(
            `[execute-tool:401-retry] Detected 401 for tool '${toolName}'. Attempting token refresh via credentialMeta...`,
          );

          try {
            const refreshResult = await refreshCredentialToken(
              effectiveCredentialMeta,
            );
            currentAccessToken = refreshResult.accessToken;
            tokenRefreshed = true;

            logger.info(
              `[execute-tool:401-retry] Token refreshed successfully. New expiry: ${new Date(refreshResult.expiresAt).toISOString()}. Retrying tool call...`,
            );

            const retryResult = await runTool(currentAccessToken);

            logger.info(
              `[execute-tool:401-retry] Tool '${toolName}' succeeded after token refresh`,
            );
            res.json({
              success: true,
              result: retryResult,
              toolName,
              tokenRefreshed: true,
              ...(resolvedServerName ? { serverName: resolvedServerName } : {}),
              ...(server ? { server } : {}),
            });
            return;
          } catch (refreshError) {
            logger.error(
              `[execute-tool:401-retry] Token refresh or retry failed:`,
              refreshError,
            );
            await evictExecuteToolConnectionVariants(cacheKey);
            throw refreshError;
          }
        }

        throw executeError;
      }
    } catch (error) {
      logger.error("[execute-tool] Error executing tool:", error);
      const statusCode = isUnauthorizedError(error) ? 401 : 500;
      res.status(statusCode).json({
        error: statusCode === 401 ? "Unauthorized" : "Internal Server Error",
        message: error instanceof Error ? error.message : String(error),
        serverName,
        toolName,
      });
    }
  },
);

// Log management endpoints
app.get("/logs", originValidationMiddleware, authMiddleware, (req, res) => {
  try {
    const files = logger.getAvailableLogFiles();
    res.json({
      success: true,
      files,
      count: files.length,
      logsDirectory: logger.getLogsDirectory(),
    });
  } catch (error) {
    logger.error("Error listing log files:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/logs/current", (req, res) => {
  try {
    const content = logger.readLogFile();
    const lines = content.split("\n").filter((line) => line.trim());

    // Support pagination
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 100;
    const totalLines = lines.length;
    const endIndex = totalLines;
    const startIndex = Math.max(0, endIndex - limit);

    const paginatedLines = lines.slice(startIndex, endIndex);
    const totalPages = Math.ceil(totalLines / limit);

    res.json({
      success: true,
      content: paginatedLines.join("\n"),
      pagination: {
        page,
        limit,
        totalLines,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      logFile: logger.getLogFilePath(),
    });
  } catch (error) {
    logger.error("Error reading current log file:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/logs/:filename", (req, res) => {
  try {
    const { filename } = req.params;
    const content = logger.readSpecificLogFile(filename);
    const lines = content.split("\n").filter((line) => line.trim());

    // Use the same pagination logic as /logs/current: always return the last N lines
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 100;
    const totalLines = lines.length;
    const endIndex = totalLines;
    const startIndex = Math.max(0, endIndex - limit);

    const paginatedLines = lines.slice(startIndex, endIndex);
    const totalPages = Math.ceil(totalLines / limit);

    res.json({
      success: true,
      filename,
      content: paginatedLines.join("\n"),
      pagination: {
        page,
        limit,
        totalLines,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    logger.error("Error reading log file:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

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
        daysToKeep,
      });
    } catch (error) {
      logger.error("Error cleaning up logs:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

app.post(
  "/logs/write",
  originValidationMiddleware,
  authMiddleware,
  express.json(),
  (req, res) => {
    try {
      const { level = "info", message = "Test log message" } = req.body;

      switch (level) {
        case "info":
          logger.info(message);
          break;
        case "warn":
          logger.warn(message);
          break;
        case "error":
          logger.error(message);
          break;
        case "debug":
          logger.debug(message);
          break;
        default:
          logger.info(message);
      }

      res.json({
        success: true,
        message: `Test log message written with level: ${level}`,
        level,
        logFile: logger.getLogFilePath(),
      });
    } catch (error) {
      logger.error("Error writing test log:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

// Open log folder in OS file manager
app.post(
  "/logs/open",
  originValidationMiddleware,
  authMiddleware,
  (req, res) => {
    try {
      const logsDir = logger.getLogsDirectory();

      logger.info(`Opening log folder: ${logsDir}`);
      logger.info(`Platform: ${process.platform}`);

      // Determine the command based on platform
      const platform = process.platform;
      let command: string;
      if (platform === "darwin") {
        command = `open "${logsDir}"`;
      } else if (platform === "win32") {
        command = `explorer "${logsDir}"`;
      } else {
        command = `xdg-open "${logsDir}"`;
      }

      logger.info(`Executing command: ${command}`);

      exec(command, (error: any, stdout: string, stderr: string) => {
        if (error) {
          logger.error(`Error opening log folder. Command: ${command}`);
          logger.error(`Error message: ${error.message}`);
          logger.error(`Error code: ${error.code}`);
          logger.error(`Error stack: ${error.stack}`);
          if (stderr) {
            logger.error(`stderr: ${stderr}`);
          }
          res.status(500).json({
            error: "Internal Server Error",
            message: error.message,
            command,
            logsDirectory: logsDir,
            code: error.code,
            stderr,
          });
          return;
        }
        logger.info(`Log folder opened successfully: ${logsDir}`);
        if (stdout) {
          logger.info(`stdout: ${stdout}`);
        }
        res.json({
          success: true,
          message: "Log folder opened",
          logsDirectory: logsDir,
        });
      });
    } catch (error: any) {
      logger.error(
        `Error opening log folder (caught): ${error?.message || String(error)}`,
      );
      logger.error(`Stack: ${error?.stack}`);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
        stack: error?.stack,
      });
    }
  },
);

// Open config file's folder in OS file manager
app.post(
  "/open-config-folder",
  originValidationMiddleware,
  authMiddleware,
  (req, res) => {
    try {
      const rawPath = (req.query.path as string) || "";
      if (!rawPath) {
        res.status(400).json({
          error: "Bad Request",
          message: "Missing 'path' query parameter",
        });
        return;
      }

      const expandedPath = expandTildePath(rawPath);

      const folderPath = path.dirname(expandedPath);

      logger.info(
        `Opening config folder: ${folderPath} (revealing ${expandedPath})`,
      );

      const platform = process.platform;
      let command: string;
      if (platform === "darwin") {
        // -R reveals and selects the file in Finder
        command = `open -R "${expandedPath}"`;
      } else if (platform === "win32") {
        command = `explorer /select,"${expandedPath}"`;
      } else {
        command = `xdg-open "${folderPath}"`;
      }

      exec(command, (error: any, stdout: string, stderr: string) => {
        if (error) {
          logger.error(`Error opening config folder: ${error.message}`);
          res.status(500).json({
            error: "Internal Server Error",
            message: error.message,
            command,
            folder: folderPath,
          });
          return;
        }
        res.json({
          success: true,
          message: "Config folder opened",
          folder: folderPath,
        });
      });
    } catch (error: any) {
      logger.error(
        `Error opening config folder (caught): ${error?.message || String(error)}`,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// Open config file directly in default editor
app.post(
  "/open-config-file",
  originValidationMiddleware,
  authMiddleware,
  (req, res) => {
    try {
      const rawPath = (req.query.path as string) || "";
      if (!rawPath) {
        res.status(400).json({
          error: "Bad Request",
          message: "Missing 'path' query parameter",
        });
        return;
      }

      const homeDir = os.homedir();
      const expandedPath = rawPath.startsWith("~/")
        ? path.join(homeDir, rawPath.slice(2))
        : rawPath === "~"
          ? homeDir
          : rawPath;

      logger.info(`[open-config-file] Opening file: ${expandedPath}`);

      // Build an ordered list of commands to try.
      // We prefer a code editor (VS Code), then fall back to the OS default
      // text editor so that unknown extensions like .n8n still open fine.
      const platform = process.platform;
      const escapedPath = `"${expandedPath}"`;
      const candidates: string[] = [];

      if (platform === "darwin") {
        candidates.push(`open ${escapedPath}`);
        candidates.push(`code ${escapedPath}`);
        // open -t opens with the default text editor on macOS (last resort)
        candidates.push(`open -t ${escapedPath}`);
      } else if (platform === "win32") {
        candidates.push(`start "" ${escapedPath}`);
        candidates.push(`code ${escapedPath}`);
      } else {
        candidates.push(`xdg-open ${escapedPath}`);
        candidates.push(`code ${escapedPath}`);
      }

      // Try each candidate in order; stop at the first one that succeeds.
      const tryNext = (idx: number) => {
        if (idx >= candidates.length) {
          logger.error(
            `[open-config-file] All open methods failed for: ${expandedPath}`,
          );
          res.status(500).json({
            error: "Internal Server Error",
            message: `Could not open file: ${expandedPath}`,
            file: expandedPath,
          });
          return;
        }

        const cmd = candidates[idx];
        logger.info(`[open-config-file] Trying editor: ${cmd}`);

        exec(cmd, (error: any, _stdout: string, _stderr: string) => {
          if (error) {
            logger.warn(`[open-config-file] '${cmd}' failed: ${error.message}`);
            tryNext(idx + 1);
            return;
          }
          logger.info(
            `[open-config-file] Opened with '${candidates[idx].split(" ")[0]}': ${expandedPath}`,
          );
          res.json({
            success: true,
            message: "Config file opened",
            file: expandedPath,
          });
        });
      };

      tryNext(0);
    } catch (error: any) {
      logger.error(
        `Error opening config file (caught): ${error?.message || String(error)}`,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// Open native file picker to choose an MCP config file
app.post(
  "/choose-file",
  originValidationMiddleware,
  authMiddleware,
  (req, res) => {
    try {
      const platform = process.platform;
      let command: string;

      if (platform === "darwin") {
        // macOS: use osascript to open a file picker dialog
        command = `osascript -e 'POSIX path of (choose file of type {"public.json"} with prompt "Select MCP config file")'`;
      } else if (platform === "win32") {
        // Windows: use PowerShell to open a file dialog
        command = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'JSON files (*.json)|*.json'; $f.Title = 'Select MCP config file'; if ($f.ShowDialog() -eq 'OK') { $f.FileName }"`;
      } else {
        // Linux: use zenity
        command = `zenity --file-selection --title="Select MCP config file" --file-filter="JSON files | *.json"`;
      }

      exec(command, (error: any, stdout: string, stderr: string) => {
        if (error) {
          // User cancelled the dialog
          if (error.code === 1 || stderr.includes("User canceled")) {
            res.json({ cancelled: true });
            return;
          }
          logger.error(`Error choosing file: ${error.message}`);
          res.status(500).json({
            error: "Internal Server Error",
            message: error.message,
          });
          return;
        }

        const filePath = stdout.trim();
        if (!filePath) {
          res.json({ cancelled: true });
          return;
        }

        // Convert absolute path to tilde path for consistency
        const homeDir = os.homedir();
        const tildePath = filePath.startsWith(homeDir)
          ? "~/" + filePath.slice(homeDir.length + 1).replace(/\\/g, "/")
          : filePath;

        logger.info(`File chosen: ${filePath} (tilde: ${tildePath})`);
        res.json({ path: tildePath, absolutePath: filePath });
      });
    } catch (error: any) {
      logger.error(
        `Error choosing file (caught): ${error?.message || String(error)}`,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);
// ── Credential Management Endpoints (folder-based) ─────────────────────────

/** Helper: parse a single credentials JSON file and return entries */
function parseCredentialFile(
  fileContent: string,
  fileName: string,
): Array<{
  id: string;
  key: string;
  serverName: string;
  serverUrl: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  expiresAt: number | null;
  isExpired: boolean;
  expiresInMs: number | null;
  scopes: string[];
  clientId: string;
  sourceFile: string;
}> {
  const parsed = JSON.parse(fileContent);
  return Object.entries(parsed).map(([key, value]: [string, any]) => ({
    id: createCredentialIdentity(fileName, key),
    key,
    serverName: value.server_name || key.split("|")[0] || "unknown",
    serverUrl: value.server_url || "",
    hasAccessToken: !!value.access_token,
    hasRefreshToken: !!value.refresh_token,
    expiresAt: value.expires_at || null,
    isExpired: value.expires_at ? Date.now() > value.expires_at : false,
    expiresInMs: value.expires_at ? value.expires_at - Date.now() : null,
    scopes: value.scopes || [],
    clientId: value.client_id || "",
    sourceFile: fileName,
  }));
}

// GET /credentials — Read all .json files from a credentials folder
app.get(
  "/credentials",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      const rawPath = (req.query.path as string) || "";
      if (!rawPath) {
        logger.warn("[credentials:GET] Missing 'path' query parameter");
        res.status(400).json({
          error: "Bad Request",
          message: "Missing 'path' query parameter",
        });
        return;
      }

      const folderPath = expandTildePath(rawPath);
      setActiveCredentialsFolderPath(rawPath, "GET /credentials");
      logger.info(
        `[credentials:GET] Reading credentials folder: ${folderPath}`,
      );

      try {
        const stat = await fs.stat(folderPath);
        if (!stat.isDirectory()) {
          logger.warn(
            `[credentials:GET] Path is not a directory: ${folderPath}`,
          );
          res.status(400).json({
            error: "Bad Request",
            message: `Path is not a directory: ${folderPath}`,
          });
          return;
        }
      } catch (statErr: any) {
        if (statErr?.code === "ENOENT") {
          // Auto-create the folder if it doesn't exist
          logger.info(
            `[credentials:GET] Folder not found, creating: ${folderPath}`,
          );
          await fs.mkdir(folderPath, { recursive: true });
        } else {
          throw statErr;
        }
      }

      // Read all .json files in the folder
      const dirEntries = await fs.readdir(folderPath);
      const jsonFiles = dirEntries.filter(
        (f) =>
          f.endsWith(".json") &&
          !f.startsWith(".") &&
          f !== CREDENTIALS_STATE_FILE,
      );

      logger.info(
        `[credentials:GET] Found ${jsonFiles.length} JSON file(s) in folder`,
      );

      const allEntries: any[] = [];
      const allCredentials: Record<string, any> = {};
      const files: Array<{
        name: string;
        entryCount: number;
        error?: string;
      }> = [];

      for (const fileName of jsonFiles) {
        const filePath = path.join(folderPath, fileName);
        try {
          const content = await fs.readFile(filePath, "utf8");
          const parsed = JSON.parse(content);
          const entries = parseCredentialFile(content, fileName);
          allEntries.push(...entries);

          // Merge into combined credentials with source file tag
          for (const [key, value] of Object.entries(parsed)) {
            const credential = {
              ...(value as any),
              _sourceFile: fileName,
              _credentialKey: key,
            };
            allCredentials[createCredentialIdentity(fileName, key)] =
              credential;
            if (!allCredentials[key]) {
              allCredentials[key] = credential;
            }
          }

          files.push({ name: fileName, entryCount: entries.length });
          logger.info(
            `[credentials:GET]   ${fileName}: ${entries.length} entry(ies)`,
          );
        } catch (fileErr: any) {
          logger.warn(
            `[credentials:GET]   ${fileName}: failed to parse — ${fileErr?.message}`,
          );
          files.push({
            name: fileName,
            entryCount: 0,
            error: fileErr?.message,
          });
        }
      }

      logger.info(
        `[credentials:GET] Total: ${allEntries.length} credential(s) from ${files.length} file(s)`,
      );

      res.json({
        success: true,
        path: folderPath,
        credentials: allCredentials,
        entries: allEntries,
        files,
        count: allEntries.length,
      });
    } catch (error: any) {
      logger.error(`[credentials:GET] Unhandled error:`, error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// PUT /credentials — Write updated credentials to a specific file in the folder
app.put(
  "/credentials",
  originValidationMiddleware,
  authMiddleware,
  express.json(),
  async (req, res) => {
    try {
      const { folderPath: rawFolder, fileName, credentials } = req.body;
      if (!rawFolder || !fileName || !credentials) {
        logger.warn(
          "[credentials:PUT] Missing 'folderPath', 'fileName', or 'credentials'",
        );
        res.status(400).json({
          error: "Bad Request",
          message:
            "'folderPath', 'fileName', and 'credentials' are all required",
        });
        return;
      }

      const folder = expandTildePath(rawFolder);
      const filePath = path.join(folder, fileName);
      logger.info(`[credentials:PUT] Writing credentials to: ${filePath}`);

      await fs.writeFile(
        filePath,
        JSON.stringify(credentials, null, 4),
        "utf8",
      );

      logger.info(
        `[credentials:PUT] Credentials written successfully to: ${filePath}`,
      );
      res.json({
        success: true,
        message: "Credentials saved successfully",
        path: filePath,
      });
    } catch (error: any) {
      logger.error(`[credentials:PUT] Error:`, error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// PATCH /credentials/name — Rename one credential entry within its source file
app.patch(
  "/credentials/name",
  originValidationMiddleware,
  authMiddleware,
  express.json(),
  async (req, res) => {
    try {
      const {
        folderPath: rawFolder,
        sourceFile,
        credentialKey,
        serverName,
      } = req.body;
      const folderPath = typeof rawFolder === "string" ? rawFolder : "";
      const credentialSourceFile =
        typeof sourceFile === "string" ? sourceFile : "";
      const key = typeof credentialKey === "string" ? credentialKey : "";
      const nextServerName =
        typeof serverName === "string" ? serverName.trim() : "";

      if (!folderPath || !credentialSourceFile || !key || !nextServerName) {
        logger.warn(
          "[credentials:name] Missing 'folderPath', 'sourceFile', 'credentialKey', or 'serverName'",
        );
        res.status(400).json({
          error: "Bad Request",
          message:
            "'folderPath', 'sourceFile', 'credentialKey', and a non-empty 'serverName' are all required",
        });
        return;
      }

      const meta: CredentialMeta = {
        folderPath,
        sourceFile: credentialSourceFile,
        credentialKey: key,
      };
      const filePath = credentialFilePath(meta);
      const credentials = await readCredentialFile(meta);
      const credential = credentials[key];
      if (!credential) {
        res.status(404).json({
          error: "Not Found",
          message: `Credential key '${key}' not found in ${credentialSourceFile}`,
        });
        return;
      }

      credentials[key] = {
        ...credential,
        server_name: nextServerName,
      };
      await fs.writeFile(
        filePath,
        JSON.stringify(credentials, null, 4),
        "utf8",
      );

      logger.info(
        `[credentials:name] Renamed credential '${key}' in ${credentialSourceFile} to '${nextServerName}'`,
      );
      res.json({
        success: true,
        credentialKey: key,
        sourceFile: credentialSourceFile,
        serverName: nextServerName,
      });
    } catch (error: any) {
      logger.error(`[credentials:name] Error:`, error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// PUT /credentials/enabled — Persist enabled credential keys for server-side lookup
app.put(
  "/credentials/enabled",
  originValidationMiddleware,
  authMiddleware,
  express.json(),
  async (req, res) => {
    try {
      const { folderPath, enabledCredentialKeys } = req.body;
      if (!Array.isArray(enabledCredentialKeys)) {
        logger.warn(
          "[credentials:enabled] Missing or invalid 'enabledCredentialKeys'",
        );
        res.status(400).json({
          error: "Bad Request",
          message: "'enabledCredentialKeys' must be an array",
        });
        return;
      }

      const keys = enabledCredentialKeys.filter(
        (value: unknown): value is string => typeof value === "string",
      );
      const effectiveFolderPath = getEffectiveCredentialsFolderPath(folderPath);
      setActiveCredentialsFolderPath(
        effectiveFolderPath,
        "PUT /credentials/enabled",
      );
      await writePersistedEnabledCredentialKeys(effectiveFolderPath, keys);
      await evictAllExecuteToolConnections("enabled credential set changed");

      res.json({
        success: true,
        folderPath: effectiveFolderPath,
        enabledCredentialKeys: keys,
        count: keys.length,
      });
    } catch (error: any) {
      logger.error(`[credentials:enabled] Error:`, error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// POST /credentials/refresh — Refresh an expired OAuth token (folder-aware)
// Delegates to the shared refreshCredentialToken() helper.
app.post(
  "/credentials/refresh",
  originValidationMiddleware,
  authMiddleware,
  express.json(),
  async (req, res) => {
    try {
      const { folderPath: rawFolder, sourceFile, credentialKey } = req.body;
      if (!rawFolder || !sourceFile || !credentialKey) {
        logger.warn(
          "[credentials:refresh] Missing 'folderPath', 'sourceFile', or 'credentialKey'",
        );
        res.status(400).json({
          error: "Bad Request",
          message:
            "'folderPath', 'sourceFile', and 'credentialKey' are all required",
        });
        return;
      }

      const result = await refreshCredentialToken({
        folderPath: rawFolder,
        sourceFile,
        credentialKey,
      });

      res.json({
        success: true,
        message: "Token refreshed successfully",
        credentialKey,
        sourceFile,
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        expiresInMs: result.expiresInMs,
      });
    } catch (error: any) {
      logger.error(`[credentials:refresh] Error:`, error);
      const statusCode = error?.message?.includes("not found")
        ? 404
        : error?.message?.includes("missing")
          ? 400
          : 500;
      res.status(statusCode).json({
        error:
          statusCode === 500 ? "Internal Server Error" : "Token Refresh Failed",
        message: error?.message || String(error),
      });
    }
  },
);

// POST /credentials/choose-folder — Open native folder picker
app.post(
  "/credentials/choose-folder",
  originValidationMiddleware,
  authMiddleware,
  (req, res) => {
    try {
      const platform = process.platform;
      let command: string;

      if (platform === "darwin") {
        command = `osascript -e 'POSIX path of (choose folder with prompt "Select credentials folder")'`;
      } else if (platform === "win32") {
        command = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select credentials folder'; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"`;
      } else {
        command = `zenity --file-selection --directory --title="Select credentials folder"`;
      }

      logger.info(`[credentials:choose-folder] Opening folder picker`);

      exec(command, (error: any, stdout: string, stderr: string) => {
        if (error) {
          if (error.code === 1 || stderr.includes("User canceled")) {
            logger.info(
              `[credentials:choose-folder] User cancelled folder picker`,
            );
            res.json({ cancelled: true });
            return;
          }
          logger.error(`[credentials:choose-folder] Error: ${error.message}`);
          res.status(500).json({
            error: "Internal Server Error",
            message: error.message,
          });
          return;
        }

        let folderPath = stdout.trim();
        // macOS osascript appends trailing slash, normalize
        if (folderPath.endsWith("/")) {
          folderPath = folderPath.slice(0, -1);
        }
        if (!folderPath) {
          logger.info(`[credentials:choose-folder] No folder selected`);
          res.json({ cancelled: true });
          return;
        }

        // Convert absolute path to tilde path for consistency
        const homeDir = os.homedir();
        const tildePath = folderPath.startsWith(homeDir)
          ? "~/" + folderPath.slice(homeDir.length + 1).replace(/\\/g, "/")
          : folderPath;

        logger.info(
          `[credentials:choose-folder] Folder chosen: ${folderPath} (tilde: ${tildePath})`,
        );
        res.json({ path: tildePath, absolutePath: folderPath });
      });
    } catch (error: any) {
      logger.error(
        `[credentials:choose-folder] Error: ${error?.message || String(error)}`,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// POST /credentials/upload — Handle drag-and-drop file into the credentials folder
app.post(
  "/credentials/upload",
  originValidationMiddleware,
  authMiddleware,
  express.json({ limit: "5mb" }),
  async (req, res) => {
    try {
      const { content, fileName, folderPath: rawFolder } = req.body;
      if (!content) {
        logger.warn("[credentials:upload] Missing 'content' in body");
        res.status(400).json({
          error: "Bad Request",
          message: "Missing 'content' in request body",
        });
        return;
      }

      // Validate JSON
      let parsed: Record<string, any>;
      try {
        parsed = typeof content === "string" ? JSON.parse(content) : content;
      } catch {
        logger.warn("[credentials:upload] Invalid JSON content");
        res.status(400).json({
          error: "Bad Request",
          message: "File content is not valid JSON",
        });
        return;
      }

      // Determine target folder: use provided folder, or default to ./data/
      const defaultFolder = path.resolve("./data");
      const targetFolder = rawFolder
        ? expandTildePath(rawFolder)
        : defaultFolder;
      const targetFile = fileName || "credentials.json";
      const targetPath = path.join(targetFolder, targetFile);

      // Ensure folder exists
      await fs.mkdir(targetFolder, { recursive: true });

      logger.info(
        `[credentials:upload] Saving dropped file to: ${targetPath} (fileName: ${targetFile})`,
      );

      // Write the file
      await fs.writeFile(targetPath, JSON.stringify(parsed, null, 4), "utf8");

      // Convert to tilde path for UI display
      const homeDir = os.homedir();
      const tildeFolderPath = targetFolder.startsWith(homeDir)
        ? "~/" + targetFolder.slice(homeDir.length + 1).replace(/\\/g, "/")
        : targetFolder;

      // Build entries summary
      const entries = parseCredentialFile(JSON.stringify(parsed), targetFile);

      logger.info(
        `[credentials:upload] Saved ${entries.length} credential(s) to ${tildeFolderPath}/${targetFile}`,
      );

      res.json({
        success: true,
        folderPath: tildeFolderPath,
        absoluteFolderPath: targetFolder,
        fileName: targetFile,
        credentials: parsed,
        entries,
        count: entries.length,
      });
    } catch (error: any) {
      logger.error(`[credentials:upload] Error:`, error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
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
