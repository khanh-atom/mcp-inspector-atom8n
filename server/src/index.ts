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

async function getOrCreateExecuteToolConnection(
  cacheKey: string,
  serverConfig: Record<string, unknown>,
  req: express.Request,
  accessToken?: string,
): Promise<CachedExecuteToolConnection> {
  // [CREDENTIALS] When an access token is provided, skip the cache to ensure fresh headers
  if (accessToken) {
    logger.info(
      `[execute-tool:credentials] Bypassing cache for cacheKey='${cacheKey}' (credential token provided)`,
    );
    await evictExecuteToolConnection(cacheKey);
    const conn = await createExecuteToolConnection(
      serverConfig,
      req,
      accessToken,
    );
    executeToolConnectionCache.set(cacheKey, conn);
    return conn;
  }
  const entry = executeToolConnectionCache.get(cacheKey);
  if (entry && "client" in entry) return entry;
  if (entry instanceof Promise) {
    try {
      return await entry;
    } catch {
      executeToolConnectionCache.delete(cacheKey);
    }
  }
  const promise = createExecuteToolConnection(serverConfig, req);
  executeToolConnectionCache.set(cacheKey, promise);
  try {
    const result = await promise;
    executeToolConnectionCache.set(cacheKey, result);
    return result;
  } catch (err) {
    executeToolConnectionCache.delete(cacheKey);
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

// New endpoint for on-demand tool execution (connections cached by serverName)
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
    }: {
      serverName?: string;
      server?: Record<string, unknown>;
      toolName?: string;
      toolArgs?: Record<string, unknown>;
      credentials?: { access_token?: string };
    } = req.body;

    // [CREDENTIALS] Log if credentials are being provided
    if (credentials?.access_token) {
      logger.info(
        `[execute-tool:credentials] Credentials provided for toolName=${toolName || "<missing>"}, token length=${credentials.access_token.length}`,
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

      // [CREDENTIALS] Pass credential access_token to inject into HTTP transport
      const { client } = await getOrCreateExecuteToolConnection(
        cacheKey,
        resolvedServerConfig,
        req,
        credentials?.access_token,
      );

      try {
        const result = await client.callTool({
          name: toolName,
          arguments: toolArgs,
        });
        logger.info(`[execute-tool] Tool '${toolName}' completed successfully`);
        res.json({
          success: true,
          result,
          toolName,
          ...(resolvedServerName ? { serverName: resolvedServerName } : {}),
          ...(server ? { server } : {}),
        });
        return;
      } catch (toolError) {
        logger.warn(
          `[execute-tool] Tool '${toolName}' failed; evicting cache key '${cacheKey}'`,
        );
        await evictExecuteToolConnection(cacheKey);
        throw toolError;
      }
    } catch (error) {
      logger.error("[execute-tool] Error executing tool:", error);
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
// ── Credential Management Endpoints ────────────────────────────────────────

// GET /credentials — Read a credentials JSON file from disk
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

      const filePath = expandTildePath(rawPath);
      logger.info(`[credentials:GET] Reading credentials from: ${filePath}`);

      try {
        const fileContent = await fs.readFile(filePath, "utf8");
        const credentials = JSON.parse(fileContent);

        // Build a summary of credential entries
        const entries = Object.entries(credentials).map(
          ([key, value]: [string, any]) => ({
            key,
            serverName: value.server_name || key.split("|")[0] || "unknown",
            serverUrl: value.server_url || "",
            hasAccessToken: !!value.access_token,
            hasRefreshToken: !!value.refresh_token,
            expiresAt: value.expires_at || null,
            isExpired: value.expires_at ? Date.now() > value.expires_at : false,
            expiresInMs: value.expires_at
              ? value.expires_at - Date.now()
              : null,
            scopes: value.scopes || [],
            clientId: value.client_id || "",
          }),
        );

        logger.info(
          `[credentials:GET] Loaded ${entries.length} credential(s) from ${filePath}`,
        );

        res.json({
          success: true,
          path: filePath,
          credentials,
          entries,
          count: entries.length,
        });
      } catch (readErr: any) {
        if (readErr?.code === "ENOENT") {
          logger.warn(
            `[credentials:GET] Credentials file not found: ${filePath}`,
          );
          res.status(404).json({
            error: "Not Found",
            message: `Credentials file not found at ${filePath}`,
          });
          return;
        }
        logger.error(`[credentials:GET] Error reading file:`, readErr);
        res.status(500).json({
          error: "Internal Server Error",
          message: readErr?.message || String(readErr),
        });
      }
    } catch (error: any) {
      logger.error(`[credentials:GET] Unhandled error:`, error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// PUT /credentials — Write updated credentials back to disk
app.put(
  "/credentials",
  originValidationMiddleware,
  authMiddleware,
  express.json(),
  async (req, res) => {
    try {
      const { path: rawPath, credentials } = req.body;
      if (!rawPath || !credentials) {
        logger.warn(
          "[credentials:PUT] Missing 'path' or 'credentials' in body",
        );
        res.status(400).json({
          error: "Bad Request",
          message: "Both 'path' and 'credentials' are required",
        });
        return;
      }

      const filePath = expandTildePath(rawPath);
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

// POST /credentials/refresh — Refresh an expired OAuth token
app.post(
  "/credentials/refresh",
  originValidationMiddleware,
  authMiddleware,
  express.json(),
  async (req, res) => {
    try {
      const { path: rawPath, credentialKey } = req.body;
      if (!rawPath || !credentialKey) {
        logger.warn(
          "[credentials:refresh] Missing 'path' or 'credentialKey' in body",
        );
        res.status(400).json({
          error: "Bad Request",
          message: "Both 'path' and 'credentialKey' are required",
        });
        return;
      }

      const filePath = expandTildePath(rawPath);
      logger.info(
        `[credentials:refresh] Refreshing token for key '${credentialKey}' in ${filePath}`,
      );

      // Read current credentials
      let credentials: Record<string, any>;
      try {
        const fileContent = await fs.readFile(filePath, "utf8");
        credentials = JSON.parse(fileContent);
      } catch (readErr: any) {
        logger.error(
          `[credentials:refresh] Failed to read credentials file:`,
          readErr,
        );
        res.status(404).json({
          error: "Not Found",
          message: `Credentials file not found or invalid: ${filePath}`,
        });
        return;
      }

      const cred = credentials[credentialKey];
      if (!cred) {
        logger.warn(
          `[credentials:refresh] Credential key '${credentialKey}' not found in file`,
        );
        res.status(404).json({
          error: "Not Found",
          message: `Credential key '${credentialKey}' not found`,
        });
        return;
      }

      if (!cred.refresh_token || !cred.client_id || !cred.server_url) {
        logger.warn(
          `[credentials:refresh] Credential '${credentialKey}' missing required fields for refresh`,
        );
        res.status(400).json({
          error: "Bad Request",
          message: "Credential missing refresh_token, client_id, or server_url",
        });
        return;
      }

      // Derive token endpoint from server URL (e.g., mcp.us3.datadoghq.com → api.us3.datadoghq.com)
      const serverUrl = new URL(cred.server_url);
      const apiHost = serverUrl.hostname.replace(/^mcp\./, "api.");
      const tokenUrl = `https://${apiHost}/oauth2/v1/token`;

      logger.info(
        `[credentials:refresh] Token refresh URL: ${tokenUrl} for server: ${cred.server_name || credentialKey}`,
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
        logger.error(
          `[credentials:refresh] Token refresh failed (${tokenResp.status}): ${text}`,
        );
        res.status(tokenResp.status).json({
          error: "Token Refresh Failed",
          message: `Token refresh failed (${tokenResp.status}): ${text}`,
        });
        return;
      }

      const data = (await tokenResp.json()) as any;

      // Update credential in memory
      cred.access_token = data.access_token;
      cred.refresh_token = data.refresh_token ?? cred.refresh_token;
      cred.expires_at = Date.now() + (data.expires_in ?? 3600) * 1000;
      credentials[credentialKey] = cred;

      // Write back to disk
      await fs.writeFile(
        filePath,
        JSON.stringify(credentials, null, 4),
        "utf8",
      );

      logger.info(
        `[credentials:refresh] Token refreshed & saved for '${credentialKey}'. New expiry: ${new Date(cred.expires_at).toISOString()}`,
      );

      res.json({
        success: true,
        message: "Token refreshed successfully",
        credentialKey,
        expiresAt: cred.expires_at,
        expiresInMs: cred.expires_at - Date.now(),
      });
    } catch (error: any) {
      logger.error(`[credentials:refresh] Error:`, error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// POST /credentials/choose-file — Open native file picker for credentials files
app.post(
  "/credentials/choose-file",
  originValidationMiddleware,
  authMiddleware,
  (req, res) => {
    try {
      const platform = process.platform;
      let command: string;

      if (platform === "darwin") {
        command = `osascript -e 'POSIX path of (choose file of type {"public.json"} with prompt "Select credentials file")'`;
      } else if (platform === "win32") {
        command = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'JSON files (*.json)|*.json'; $f.Title = 'Select credentials file'; if ($f.ShowDialog() -eq 'OK') { $f.FileName }"`;
      } else {
        command = `zenity --file-selection --title="Select credentials file" --file-filter="JSON files | *.json"`;
      }

      logger.info(`[credentials:choose-file] Opening file picker`);

      exec(command, (error: any, stdout: string, stderr: string) => {
        if (error) {
          if (error.code === 1 || stderr.includes("User canceled")) {
            logger.info(`[credentials:choose-file] User cancelled file picker`);
            res.json({ cancelled: true });
            return;
          }
          logger.error(`[credentials:choose-file] Error: ${error.message}`);
          res.status(500).json({
            error: "Internal Server Error",
            message: error.message,
          });
          return;
        }

        const filePath = stdout.trim();
        if (!filePath) {
          logger.info(`[credentials:choose-file] No file selected`);
          res.json({ cancelled: true });
          return;
        }

        // Convert absolute path to tilde path for consistency
        const homeDir = os.homedir();
        const tildePath = filePath.startsWith(homeDir)
          ? "~/" + filePath.slice(homeDir.length + 1).replace(/\\/g, "/")
          : filePath;

        logger.info(
          `[credentials:choose-file] File chosen: ${filePath} (tilde: ${tildePath})`,
        );
        res.json({ path: tildePath, absolutePath: filePath });
      });
    } catch (error: any) {
      logger.error(
        `[credentials:choose-file] Error: ${error?.message || String(error)}`,
      );
      res.status(500).json({
        error: "Internal Server Error",
        message: error?.message || String(error),
      });
    }
  },
);

// POST /credentials/upload — Handle drag-and-drop file content upload
app.post(
  "/credentials/upload",
  originValidationMiddleware,
  authMiddleware,
  express.json({ limit: "5mb" }),
  async (req, res) => {
    try {
      const { content, fileName, savePath } = req.body;
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

      // Determine save path: use provided path, or default to ~/.credentials.json
      const defaultPath = path.join(
        os.homedir(),
        fileName || ".credentials.json",
      );
      const targetPath = savePath ? expandTildePath(savePath) : defaultPath;

      logger.info(
        `[credentials:upload] Saving dropped file to: ${targetPath} (fileName: ${fileName || "<none>"})`,
      );

      // Write the file
      await fs.writeFile(targetPath, JSON.stringify(parsed, null, 4), "utf8");

      // Convert to tilde path for UI display
      const homeDir = os.homedir();
      const tildePath = targetPath.startsWith(homeDir)
        ? "~/" + targetPath.slice(homeDir.length + 1).replace(/\\/g, "/")
        : targetPath;

      // Build entries summary (same logic as GET /credentials)
      const entries = Object.entries(parsed).map(
        ([key, value]: [string, any]) => ({
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
        }),
      );

      logger.info(
        `[credentials:upload] Saved ${entries.length} credential(s) to ${tildePath}`,
      );

      res.json({
        success: true,
        path: tildePath,
        absolutePath: targetPath,
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
