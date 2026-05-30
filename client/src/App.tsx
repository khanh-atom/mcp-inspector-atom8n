import {
  ClientRequest,
  CompatibilityCallToolResult,
  CompatibilityCallToolResultSchema,
  CreateMessageResult,
  EmptyResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
  Resource,
  ResourceTemplate,
  Root,
  ServerNotification,
  Tool,
  LoggingLevel,
} from "@modelcontextprotocol/sdk/types.js";
import { OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SESSION_KEYS, getServerSpecificKey } from "./lib/constants";
import { AuthDebuggerState, EMPTY_DEBUGGER_STATE } from "./lib/auth-types";
import { OAuthStateMachine } from "./lib/oauth-state-machine";
import { cacheToolOutputSchemas } from "./utils/schemaUtils";
import { cleanParams } from "./utils/paramUtils";
import type { JsonSchemaType } from "./utils/jsonUtils";
import React, {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useConnection } from "./lib/hooks/useConnection";
import {
  useDraggablePane,
  useDraggableSidebar,
} from "./lib/hooks/useDraggablePane";
import { useToast } from "./lib/hooks/useToast";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Files,
  FileText,
  FolderTree,
  GitFork,
  Hammer,
  Hash,
  Key,
  MessageSquare,
  Store,
  PanelLeftClose,
  PanelLeft,
  Shield,
} from "lucide-react";

import { z } from "zod";
import "./App.css";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import AuthDebugger from "./components/AuthDebugger";
import ConsoleTab from "./components/ConsoleTab";
import HistoryAndNotifications from "./components/HistoryAndNotifications";
import PingTab from "./components/PingTab";
import PromptsTab, { Prompt } from "./components/PromptsTab";
import ResourcesTab from "./components/ResourcesTab";
import RootsTab from "./components/RootsTab";
import SamplingTab, { PendingRequest } from "./components/SamplingTab";
import Sidebar from "./components/Sidebar";
import ToolsTab from "./components/ToolsTab";
import { InspectorConfig } from "./lib/configurationTypes";
import {
  getMCPProxyAddress,
  getMCPProxyAuthToken,
  getInitialSseUrl,
  getInitialTransportType,
  getInitialCommand,
  getInitialArgs,
  initializeInspectorConfig,
  saveInspectorConfig,
} from "./utils/configUtils";
import ElicitationTab, {
  PendingElicitationRequest,
  ElicitationResponse,
} from "./components/ElicitationTab";
import MCPStoreTab from "./components/MCPStoreTab";
import CredentialsTab from "./components/CredentialsTab";
import type { RawCredentials } from "./components/CredentialsTab";
import LoggerTab from "./components/LoggerTab";
import {
  CustomHeaders,
  migrateFromLegacyAuth,
} from "./lib/types/customHeaders";

const N8N_MCP_KEY = "n8n-workflow-mcp";

// [FORK] n8n fork mode constants
const N8N_FORK_SERVER_URL = "localhost:5888";

const CONFIG_LOCAL_STORAGE_KEY = "inspectorConfig_v1";

const App = () => {
  const { toast } = useToast();
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourceTemplates, setResourceTemplates] = useState<
    ResourceTemplate[]
  >([]);
  const [resourceContent, setResourceContent] = useState<string>("");
  const [resourceContentMap, setResourceContentMap] = useState<
    Record<string, string>
  >({});
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [promptContent, setPromptContent] = useState<string>("");
  const [tools, setTools] = useState<Tool[]>([]);
  const [toolResult, setToolResult] =
    useState<CompatibilityCallToolResult | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({
    resources: null,
    prompts: null,
    tools: null,
  });
  const [command, setCommand] = useState<string>(getInitialCommand);
  const [args, setArgs] = useState<string>(getInitialArgs);
  const [configFilePath, setConfigFilePath] = useState<string>(() => {
    return localStorage.getItem("lastConfigFilePath") || `~/.cursor/mcp.json`;
  });

  const [sseUrl, setSseUrl] = useState<string>(getInitialSseUrl);
  const [transportType, setTransportType] = useState<
    "stdio" | "sse" | "streamable-http"
  >(getInitialTransportType);
  const [connectionType, setConnectionType] = useState<"direct" | "proxy">(
    () => {
      return (
        (localStorage.getItem("lastConnectionType") as "direct" | "proxy") ||
        "proxy"
      );
    },
  );
  const [logLevel, setLogLevel] = useState<LoggingLevel>("debug");
  const [notifications, setNotifications] = useState<ServerNotification[]>([]);
  const [roots, setRoots] = useState<Root[]>([]);
  const [env, setEnv] = useState<Record<string, string>>({});
  const [currentServerName, setCurrentServerName] = useState<string | null>(
    null,
  );

  const [config, setConfig] = useState<InspectorConfig>(() =>
    initializeInspectorConfig(CONFIG_LOCAL_STORAGE_KEY),
  );
  const [bearerToken, setBearerToken] = useState<string>(() => {
    return localStorage.getItem("lastBearerToken") || "";
  });

  const [headerName, setHeaderName] = useState<string>(() => {
    return localStorage.getItem("lastHeaderName") || "";
  });

  const [oauthClientId, setOauthClientId] = useState<string>(() => {
    return localStorage.getItem("lastOauthClientId") || "";
  });

  const [oauthScope, setOauthScope] = useState<string>(() => {
    return localStorage.getItem("lastOauthScope") || "";
  });

  const [oauthClientSecret, setOauthClientSecret] = useState<string>(() => {
    return localStorage.getItem("lastOauthClientSecret") || "";
  });

  // Custom headers state with migration from legacy auth
  const [customHeaders, setCustomHeaders] = useState<CustomHeaders>(() => {
    const savedHeaders = localStorage.getItem("lastCustomHeaders");
    if (savedHeaders) {
      try {
        return JSON.parse(savedHeaders);
      } catch (error) {
        console.warn(
          `Failed to parse custom headers: "${savedHeaders}", will try legacy migration`,
          error,
        );
        // Fall back to migration if JSON parsing fails
      }
    }

    // Migrate from legacy auth if available
    const legacyToken = localStorage.getItem("lastBearerToken") || "";
    const legacyHeaderName = localStorage.getItem("lastHeaderName") || "";

    if (legacyToken) {
      return migrateFromLegacyAuth(legacyToken, legacyHeaderName);
    }

    // Default to empty array
    return [];
  });

  const [pendingSampleRequests, setPendingSampleRequests] = useState<
    Array<
      PendingRequest & {
        resolve: (result: CreateMessageResult) => void;
        reject: (error: Error) => void;
      }
    >
  >([]);
  const [pendingElicitationRequests, setPendingElicitationRequests] = useState<
    Array<
      PendingElicitationRequest & {
        resolve: (response: ElicitationResponse) => void;
        decline: (error: Error) => void;
      }
    >
  >([]);
  const [isAuthDebuggerVisible, setIsAuthDebuggerVisible] = useState(false);
  const [currentServers, setCurrentServers] = useState<Record<string, any>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem("sidebarCollapsed");
    return saved === "true";
  });
  const [activeConfigPath, setActiveConfigPath] = useState(
    () => localStorage.getItem("activeConfigPath") || "",
  );

  // Persist sidebar collapsed state
  useEffect(() => {
    localStorage.setItem("sidebarCollapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  const [configRefreshKey, setConfigRefreshKey] = useState(0);
  // [CREDENTIALS] State for credential management
  const [credentialsFilePath, setCredentialsFilePath] = useState<string>(
    () => localStorage.getItem("credentialsFilePath") || "",
  );
  const [enabledCredentials, setEnabledCredentials] = useState<Set<string>>(
    () => {
      const saved = localStorage.getItem("enabledCredentials");
      if (saved) {
        try {
          return new Set(JSON.parse(saved) as string[]);
        } catch {
          return new Set<string>();
        }
      }
      return new Set<string>();
    },
  );
  const [rawCredentials, setRawCredentials] = useState<RawCredentials | null>(
    null,
  );
  const [crashError, setCrashError] = useState<string | null>(null);
  // [FORK] State for showing the "switch to fork" dialog when n8n tool call fails
  const [showForkDialog, setShowForkDialog] = useState(false);
  const [forkErrorMessage, setForkErrorMessage] = useState<string | null>(null);

  // When sidebar is collapsed, load config directly since Sidebar is unmounted
  useEffect(() => {
    if (!sidebarCollapsed || configRefreshKey === 0) return;
    const path = localStorage.getItem("activeConfigPath");
    if (!path) return;

    const load = async () => {
      try {
        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);
        const url = `${baseUrl}/mcp-config?path=${encodeURIComponent(path)}`;
        const resp = await fetch(url, {
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.path) setConfigFilePath(data.path);
        const configData = data.config as any;
        const servers = (configData.servers || configData.mcpServers) as
          | Record<string, any>
          | undefined;
        if (servers) {
          setCurrentServers(servers);
          // Apply first server config
          const names = Object.keys(servers);
          if (names.length > 0) {
            const first = servers[names[0]];
            if (first.command) {
              setTransportType("stdio");
              setCommand(first.command);
              setArgs(first.args ? first.args.join(" ") : "");
              if (first.env) setEnv(first.env);
            }
          }
        } else {
          setCurrentServers({});
        }
      } catch (e) {
        console.error("[App] Error loading config while sidebar collapsed:", e);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configRefreshKey, sidebarCollapsed]);

  // Reload config file from disk and reconnect with updated values
  const reloadConfigAndReconnect = async () => {
    const path = configFilePath || localStorage.getItem("activeConfigPath");
    if (!path) {
      console.warn(
        "[App] No config path to reload, reconnecting with current values",
      );
      connectMcpServer();
      return;
    }
    try {
      console.log(`[App] Reloading config from: ${path}`);
      const baseUrl = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      const url = `${baseUrl}/mcp-config?path=${encodeURIComponent(path)}`;
      const resp = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
          [header]: token ? `Bearer ${token}` : "",
        },
      });
      if (!resp.ok) {
        console.error(`[App] Config fetch failed: ${resp.status}`);
        connectMcpServer();
        return;
      }
      const data = await resp.json();
      const configData = data.config as any;
      const servers = (configData.servers || configData.mcpServers) as
        | Record<string, any>
        | undefined;
      if (servers) {
        // Find the currently-selected server by matching command
        const serverName =
          Object.keys(servers).find((name) => {
            const s = servers[name];
            return s.command === command;
          }) || Object.keys(servers)[0];
        const serverConfig = servers[serverName];
        if (serverConfig?.command) {
          console.log(
            `[App] Applying refreshed config for "${serverName}": command=${serverConfig.command}, args=${JSON.stringify(serverConfig.args)}`,
          );
          setCommand(serverConfig.command);
          setArgs(serverConfig.args ? serverConfig.args.join(" ") : "");
          if (serverConfig.env) setEnv(serverConfig.env);
        }
      }
      // Also refresh sidebar
      setConfigRefreshKey((k) => k + 1);
      // Wait for React re-render with new state, then connect using ref
      console.log(
        "[App] State updated, waiting for React re-render before connecting...",
      );
      setTimeout(() => {
        console.log("[App] Reconnecting after config reload (via ref)");
        connectMcpServerRef.current();
      }, 500);
    } catch (e) {
      console.error("[App] Error reloading config:", e);
      connectMcpServer();
    }
  };

  const [authState, setAuthState] =
    useState<AuthDebuggerState>(EMPTY_DEBUGGER_STATE);

  const updateAuthState = (updates: Partial<AuthDebuggerState>) => {
    setAuthState((prev) => ({ ...prev, ...updates }));
  };

  // Ref to track pending test connection config — triggers connect via useEffect
  const pendingTestConnectRef = useRef<{
    command?: string;
    args?: string;
    sseUrl?: string;
    transportType: "stdio" | "sse" | "streamable-http";
  } | null>(null);

  const handleTestConnection = async (serverConfig: any) => {
    // Apply the server configuration for testing
    if (serverConfig.command) {
      const newCmd = serverConfig.command;
      const newArgs = serverConfig.args ? serverConfig.args.join(" ") : "";
      setTransportType("stdio");
      setCommand(newCmd);
      setArgs(newArgs);
      if (serverConfig.env) {
        setEnv(serverConfig.env);
      }
      pendingTestConnectRef.current = {
        command: newCmd,
        args: newArgs,
        transportType: "stdio",
      };
    } else if (
      serverConfig.type === "streamable-http" ||
      serverConfig.type === "sse" ||
      serverConfig.url
    ) {
      const newUrl = serverConfig.url || serverConfig.sseUrl || "";
      const newTransport =
        serverConfig.type === "streamable-http" ? "streamable-http" : "sse";
      setTransportType(newTransport);
      setSseUrl(newUrl);
      pendingTestConnectRef.current = {
        sseUrl: newUrl,
        transportType: newTransport,
      };
    }

    // Navigate to Tools tab for immediate feedback
    setActiveTab("tools");
    window.location.hash = "tools";

    // If already connected or connecting, disconnect first
    try {
      if (
        connectionStatus === "connected" ||
        connectionStatus === "connecting"
      ) {
        await disconnectMcpServer();
      }
    } catch {
      // ignore disconnect errors
    }

    toast({
      title: "Connecting",
      description: "Attempting to connect to the selected MCP server...",
    });
  };

  const nextRequestId = useRef(0);
  const rootsRef = useRef<Root[]>([]);

  const [selectedResource, setSelectedResource] = useState<Resource | null>(
    null,
  );
  const [resourceSubscriptions, setResourceSubscriptions] = useState<
    Set<string>
  >(new Set<string>());

  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [nextResourceCursor, setNextResourceCursor] = useState<
    string | undefined
  >();
  const [nextResourceTemplateCursor, setNextResourceTemplateCursor] = useState<
    string | undefined
  >();
  const [nextPromptCursor, setNextPromptCursor] = useState<
    string | undefined
  >();
  const [nextToolCursor, setNextToolCursor] = useState<string | undefined>();
  const progressTokenRef = useRef(0);

  const [activeTab, setActiveTab] = useState<string>(() => {
    const hash = window.location.hash.slice(1);
    const initialTab = hash || "store";
    return initialTab;
  });

  const currentTabRef = useRef<string>(activeTab);
  const lastToolCallOriginTabRef = useRef<string>(activeTab);
  // [FORK] Detect if the currently connected server is an n8n-workflow-mcp server
  const isCurrentServerN8nWorkflow = (): boolean => {
    // Check by server name
    if (currentServerName === N8N_MCP_KEY) {
      console.log("[App:fork] Current server is n8n-workflow-mcp (by name)");
      return true;
    }
    // Check by command args pattern: "npm exec n8n-atom-cli mcp ..."
    if (transportType === "stdio") {
      const currentArgs = args.trim() ? args.trim().split(/\s+/) : [];
      if (
        command === "npm" &&
        currentArgs.length >= 3 &&
        currentArgs[0] === "exec" &&
        currentArgs[1] === "n8n-atom-cli" &&
        currentArgs[2] === "mcp"
      ) {
        console.log(
          "[App:fork] Current server is n8n-workflow-mcp (by args pattern)",
        );
        return true;
      }
    }
    return false;
  };

  // [FORK] Handle switching to fork mode for n8n workflows
  const handleSwitchToFork = async () => {
    console.log("[App:fork] Switching to fork mode...");
    setShowForkDialog(false);
    setForkErrorMessage(null);

    try {
      // Attempt 1: Try VSCode postMessage to invoke mcp-inspector.switchToFork command
      console.log("[App:fork] Attempting to switch via VSCode postMessage...");
      const vscodeSwitched = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          console.log(
            "[App:fork] VSCode postMessage timed out after 2s, will try SSE fallback",
          );
          window.removeEventListener("message", handler);
          resolve(false);
        }, 2000);

        const handler = (event: MessageEvent) => {
          if (event.data && event.data.type === "switchToForkResponse") {
            console.log(
              "[App:fork] Received switchToForkResponse from VSCode:",
              {
                success: event.data.success,
                error: event.data.error,
              },
            );
            clearTimeout(timeout);
            window.removeEventListener("message", handler);
            resolve(!!event.data.success);
          }
        };

        window.addEventListener("message", handler);
        // Send request to parent (VSCode webview bridge)
        console.log("[App:fork] Sending switchToFork postMessage to parent");
        window.parent.postMessage({ type: "switchToFork" }, "*");
      });

      if (vscodeSwitched) {
        console.log("[App:fork] Fork switch completed successfully via VSCode");
        toast({
          title: "Switched to Fork",
          description: "Fork mode activated via VSCode extension.",
        });
        return;
      }

      // Attempt 2: Fall back to SSE-based approach
      console.log("[App:fork] Falling back to SSE-based fork switch...");

      // Disconnect current server first
      if (
        connectionStatus === "connected" ||
        connectionStatus === "connecting"
      ) {
        console.log("[App:fork] Disconnecting current server...");
        await disconnectMcpServer();
      }

      // Switch transport to SSE with fork URL
      const forkUrl = `http://${N8N_FORK_SERVER_URL}`;
      console.log(`[App:fork] Setting SSE URL to: ${forkUrl}`);
      setTransportType("sse");
      setSseUrl(forkUrl);

      toast({
        title: "Switching to Fork",
        description: `Connecting to n8n fork server at ${N8N_FORK_SERVER_URL}...`,
      });

      // Use pending test connect mechanism to connect after state update
      pendingTestConnectRef.current = {
        sseUrl: forkUrl,
        transportType: "sse",
      };

      console.log("[App:fork] Fork switch initiated successfully");
    } catch (error) {
      console.error("[App:fork] Error switching to fork:", error);
      toast({
        title: "Fork Switch Failed",
        description: `Failed to switch to fork: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
    }
  };
  const manualServerConfig =
    transportType === "stdio"
      ? {
          command,
          args: args.trim() ? args.trim().split(/\s+/) : [],
          env: { ...env },
        }
      : transportType === "streamable-http"
        ? {
            type: "streamable-http",
            url: sseUrl,
          }
        : {
            type: "sse",
            url: sseUrl,
          };
  // Always use manualServerConfig for cURL since it reflects the actual current
  // connection state. currentServerConfig comes from the config file and may not
  // match the currently-connected server (e.g. fallback to first server in config).
  const serverConfigForCurl = manualServerConfig;
  console.log(
    "[App] serverConfigForCurl derived from transportType:",
    transportType,
    "config:",
    JSON.stringify(serverConfigForCurl),
  );

  useEffect(() => {
    currentTabRef.current = activeTab;
  }, [activeTab]);

  const { height: historyPaneHeight, handleDragStart } = useDraggablePane(300);
  const {
    width: sidebarWidth,
    isDragging: isSidebarDragging,
    handleDragStart: handleSidebarDragStart,
  } = useDraggableSidebar(320);

  const {
    connectionStatus,
    serverCapabilities,
    mcpClient,
    requestHistory,
    clearRequestHistory,
    makeRequest,
    sendNotification,
    handleCompletion,
    completionsSupported,
    connect: connectMcpServer,
    disconnect: disconnectMcpServer,
  } = useConnection({
    transportType,
    command,
    args,
    sseUrl,
    env,
    customHeaders,
    oauthClientId,
    oauthClientSecret,
    oauthScope,
    config,
    connectionType,
    onNotification: (notification) => {
      setNotifications((prev) => [...prev, notification as ServerNotification]);
      // Detect fatal process crash from proxy — show error dialog and disconnect
      const params = (notification as any)?.params;
      if (
        params?.level === "emergency" &&
        params?.logger === "proxy" &&
        params?.data?.type === "process_crash"
      ) {
        const errorMsg = params.data.message || "MCP server process crashed";
        setCrashError(errorMsg);
        // Auto-disconnect to stop EventSource reconnection loop
        setTimeout(() => {
          disconnectMcpServer();
        }, 100);
      }
    },
    onPendingRequest: (request, resolve, reject) => {
      setPendingSampleRequests((prev) => [
        ...prev,
        { id: nextRequestId.current++, request, resolve, reject },
      ]);
    },
    onElicitationRequest: (request, resolve) => {
      const currentTab = lastToolCallOriginTabRef.current;

      setPendingElicitationRequests((prev) => [
        ...prev,
        {
          id: nextRequestId.current++,
          request: {
            id: nextRequestId.current,
            message: request.params.message,
            requestedSchema: request.params.requestedSchema,
          },
          originatingTab: currentTab,
          resolve,
          decline: (error: Error) => {
            console.error("Elicitation request rejected:", error);
          },
        },
      ]);

      setActiveTab("elicitations");
      window.location.hash = "elicitations";
    },
    getRoots: () => rootsRef.current,
    defaultLoggingLevel: logLevel,
  });

  // Ref to always hold the latest connectMcpServer (avoids stale closure in setTimeout)
  const connectMcpServerRef = useRef(connectMcpServer);
  connectMcpServerRef.current = connectMcpServer;
  // Effect: connect once React state matches the pending test connection config
  useEffect(() => {
    const pending = pendingTestConnectRef.current;
    if (!pending) return;

    // Verify state has flushed to match the pending config
    if (pending.transportType === "stdio") {
      if (command !== pending.command || args !== pending.args) return;
    } else {
      if (sseUrl !== pending.sseUrl) return;
    }

    // State is in sync – clear flag and connect
    pendingTestConnectRef.current = null;
    void connectMcpServer();
  }, [command, args, sseUrl, transportType, connectMcpServer]);

  useEffect(() => {
    if (serverCapabilities) {
      const hash = window.location.hash.slice(1);

      const validTabs = [
        ...(serverCapabilities?.resources ? ["resources"] : []),
        ...(serverCapabilities?.prompts ? ["prompts"] : []),
        ...(serverCapabilities?.tools ? ["tools"] : []),
        "ping",
        "sampling",
        "elicitations",
        "roots",
        "auth",
        "credentials",
        "store",
      ];

      const isValidTab = validTabs.includes(hash);

      if (!isValidTab) {
        const defaultTab = serverCapabilities?.resources
          ? "resources"
          : serverCapabilities?.prompts
            ? "prompts"
            : serverCapabilities?.tools
              ? "tools"
              : "ping";

        setActiveTab(defaultTab);
        window.location.hash = defaultTab;
      }
    }
  }, [serverCapabilities]);

  useEffect(() => {
    localStorage.setItem("lastCommand", command);
  }, [command]);

  useEffect(() => {
    localStorage.setItem("lastArgs", args);
  }, [args]);

  useEffect(() => {
    localStorage.setItem("lastSseUrl", sseUrl);
  }, [sseUrl]);

  useEffect(() => {
    localStorage.setItem("lastTransportType", transportType);
  }, [transportType]);

  useEffect(() => {
    localStorage.setItem("lastConnectionType", connectionType);
  }, [connectionType]);

  useEffect(() => {
    if (bearerToken) {
      localStorage.setItem("lastBearerToken", bearerToken);
    } else {
      localStorage.removeItem("lastBearerToken");
    }
  }, [bearerToken]);

  useEffect(() => {
    if (headerName) {
      localStorage.setItem("lastHeaderName", headerName);
    } else {
      localStorage.removeItem("lastHeaderName");
    }
  }, [headerName]);

  useEffect(() => {
    localStorage.setItem("lastCustomHeaders", JSON.stringify(customHeaders));
  }, [customHeaders]);

  // Auto-migrate from legacy auth when custom headers are empty but legacy auth exists
  useEffect(() => {
    if (customHeaders.length === 0 && (bearerToken || headerName)) {
      const migratedHeaders = migrateFromLegacyAuth(bearerToken, headerName);
      if (migratedHeaders.length > 0) {
        setCustomHeaders(migratedHeaders);
        // Clear legacy auth after migration
        setBearerToken("");
        setHeaderName("");
      }
    }
  }, [bearerToken, headerName, customHeaders, setCustomHeaders]);

  useEffect(() => {
    localStorage.setItem("lastOauthClientId", oauthClientId);
  }, [oauthClientId]);

  useEffect(() => {
    localStorage.setItem("lastOauthScope", oauthScope);
  }, [oauthScope]);

  useEffect(() => {
    localStorage.setItem("lastOauthClientSecret", oauthClientSecret);
  }, [oauthClientSecret]);

  useEffect(() => {
    saveInspectorConfig(CONFIG_LOCAL_STORAGE_KEY, config);
  }, [config]);

  const onOAuthConnect = useCallback(
    (serverUrl: string) => {
      setSseUrl(serverUrl);
      setIsAuthDebuggerVisible(false);
      void connectMcpServer();
    },
    [connectMcpServer],
  );

  const onOAuthDebugConnect = useCallback(
    async ({
      authorizationCode,
      errorMsg,
      restoredState,
    }: {
      authorizationCode?: string;
      errorMsg?: string;
      restoredState?: AuthDebuggerState;
    }) => {
      setIsAuthDebuggerVisible(true);

      if (errorMsg) {
        updateAuthState({
          latestError: new Error(errorMsg),
        });
        return;
      }

      if (restoredState && authorizationCode) {
        let currentState: AuthDebuggerState = {
          ...restoredState,
          authorizationCode,
          oauthStep: "token_request",
          isInitiatingAuth: true,
          statusMessage: null,
          latestError: null,
        };

        try {
          const stateMachine = new OAuthStateMachine(sseUrl, (updates) => {
            currentState = { ...currentState, ...updates };
          });

          while (
            currentState.oauthStep !== "complete" &&
            currentState.oauthStep !== "authorization_code"
          ) {
            await stateMachine.executeStep(currentState);
          }

          if (currentState.oauthStep === "complete") {
            updateAuthState({
              ...currentState,
              statusMessage: {
                type: "success",
                message: "Authentication completed successfully",
              },
              isInitiatingAuth: false,
            });
          }
        } catch (error) {
          console.error("OAuth continuation error:", error);
          updateAuthState({
            latestError:
              error instanceof Error ? error : new Error(String(error)),
            statusMessage: {
              type: "error",
              message: `Failed to complete OAuth flow: ${error instanceof Error ? error.message : String(error)}`,
            },
            isInitiatingAuth: false,
          });
        }
      } else if (authorizationCode) {
        updateAuthState({
          authorizationCode,
          oauthStep: "token_request",
        });
      }
    },
    [sseUrl],
  );

  useEffect(() => {
    const loadOAuthTokens = async () => {
      try {
        if (sseUrl) {
          const key = getServerSpecificKey(SESSION_KEYS.TOKENS, sseUrl);
          const tokens = sessionStorage.getItem(key);
          if (tokens) {
            const parsedTokens = await OAuthTokensSchema.parseAsync(
              JSON.parse(tokens),
            );
            updateAuthState({
              oauthTokens: parsedTokens,
              oauthStep: "complete",
            });
          }
        }
      } catch (error) {
        console.error("Error loading OAuth tokens:", error);
      }
    };

    loadOAuthTokens();
  }, [sseUrl]);

  useEffect(() => {
    const headers: HeadersInit = {};
    const { token: proxyAuthToken, header: proxyAuthTokenHeader } =
      getMCPProxyAuthToken(config);
    if (proxyAuthToken) {
      headers[proxyAuthTokenHeader] = `Bearer ${proxyAuthToken}`;
    }

    fetch(`${getMCPProxyAddress(config)}/config`, { headers })
      .then((response) => response.json())
      .then((data) => {
        setEnv(data.defaultEnvironment);
        if (data.defaultCommand) {
          setCommand(data.defaultCommand);
        }
        if (data.defaultArgs) {
          setArgs(data.defaultArgs);
        }
        if (data.defaultTransport) {
          setTransportType(
            data.defaultTransport as "stdio" | "sse" | "streamable-http",
          );
        }
        if (data.defaultServerUrl) {
          setSseUrl(data.defaultServerUrl);
        }
      })
      .catch((error) =>
        console.error("Error fetching default environment:", error),
      );
  }, [config]);

  // Resolve current server name from ~/.cursor/mcp.json via proxy
  useEffect(() => {
    const resolveServerName = async () => {
      try {
        const resp = await fetch(`${getMCPProxyAddress(config)}/servers`);
        if (!resp.ok) return;
        const data = await resp.json();
        const servers: Array<{ name: string; config: any }> =
          data.servers || [];

        let matched: string | null = null;

        if (transportType === "stdio") {
          for (const s of servers) {
            const cfg = s.config || {};
            const cfgCmd = cfg.command;
            const cfgArgs: string[] = Array.isArray(cfg.args) ? cfg.args : [];
            const currentArgs = args.trim() ? args.trim().split(/\s+/) : [];
            if (
              cfgCmd === command &&
              JSON.stringify(cfgArgs) === JSON.stringify(currentArgs)
            ) {
              matched = s.name;
              break;
            }
          }
        } else {
          for (const s of servers) {
            const cfg = s.config || {};
            const url = cfg.url || cfg.sseUrl;
            if (url && url === sseUrl) {
              matched = s.name;
              break;
            }
          }
        }

        // No fallback — only set server name when we have an exact match.
        // Falling back to the first server caused the wrong config to be used
        // (e.g. always showing n8n in cURL output).
        setCurrentServerName(matched || null);
      } catch (e) {
        // ignore resolution errors
      }
    };

    void resolveServerName();
  }, [transportType, command, args, sseUrl, env, config]);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    if (mcpClient && !window.location.hash) {
      const defaultTab = serverCapabilities?.resources
        ? "resources"
        : serverCapabilities?.prompts
          ? "prompts"
          : serverCapabilities?.tools
            ? "tools"
            : "ping";
      window.location.hash = defaultTab;
    } else if (!mcpClient && window.location.hash) {
      // Clear hash when disconnected - completely remove the fragment
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }, [mcpClient, serverCapabilities]);

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1);
      if (hash && hash !== activeTab) {
        setActiveTab(hash);
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [activeTab]);

  const handleApproveSampling = (id: number, result: CreateMessageResult) => {
    setPendingSampleRequests((prev) => {
      const request = prev.find((r) => r.id === id);
      request?.resolve(result);
      return prev.filter((r) => r.id !== id);
    });
  };

  const handleRejectSampling = (id: number) => {
    setPendingSampleRequests((prev) => {
      const request = prev.find((r) => r.id === id);
      request?.reject(new Error("Sampling request rejected"));
      return prev.filter((r) => r.id !== id);
    });
  };

  const handleResolveElicitation = (
    id: number,
    response: ElicitationResponse,
  ) => {
    setPendingElicitationRequests((prev) => {
      const request = prev.find((r) => r.id === id);
      if (request) {
        request.resolve(response);

        if (request.originatingTab) {
          const originatingTab = request.originatingTab;

          const validTabs = [
            ...(serverCapabilities?.resources ? ["resources"] : []),
            ...(serverCapabilities?.prompts ? ["prompts"] : []),
            ...(serverCapabilities?.tools ? ["tools"] : []),
            "ping",
            "sampling",
            "elicitations",
            "roots",
            "auth",
            "store",
          ];

          if (validTabs.includes(originatingTab)) {
            setActiveTab(originatingTab);
            window.location.hash = originatingTab;

            setTimeout(() => {
              setActiveTab(originatingTab);
              window.location.hash = originatingTab;
            }, 100);
          }
        }
      }
      return prev.filter((r) => r.id !== id);
    });
  };

  const clearError = (tabKey: keyof typeof errors) => {
    setErrors((prev) => ({ ...prev, [tabKey]: null }));
  };

  const sendMCPRequest = async <T extends z.ZodType>(
    request: ClientRequest,
    schema: T,
    tabKey?: keyof typeof errors,
  ) => {
    try {
      const response = await makeRequest(request, schema);
      if (tabKey !== undefined) {
        clearError(tabKey);
      }
      return response;
    } catch (e) {
      const errorString = (e as Error).message ?? String(e);
      if (tabKey !== undefined) {
        setErrors((prev) => ({
          ...prev,
          [tabKey]: errorString,
        }));
      }
      throw e;
    }
  };

  const listResources = async () => {
    const response = await sendMCPRequest(
      {
        method: "resources/list" as const,
        params: nextResourceCursor ? { cursor: nextResourceCursor } : {},
      },
      ListResourcesResultSchema,
      "resources",
    );
    setResources(resources.concat(response.resources ?? []));
    setNextResourceCursor(response.nextCursor);
  };

  const listResourceTemplates = async () => {
    const response = await sendMCPRequest(
      {
        method: "resources/templates/list" as const,
        params: nextResourceTemplateCursor
          ? { cursor: nextResourceTemplateCursor }
          : {},
      },
      ListResourceTemplatesResultSchema,
      "resources",
    );
    setResourceTemplates(
      resourceTemplates.concat(response.resourceTemplates ?? []),
    );
    setNextResourceTemplateCursor(response.nextCursor);
  };

  const getPrompt = async (name: string, args: Record<string, string> = {}) => {
    lastToolCallOriginTabRef.current = currentTabRef.current;

    const response = await sendMCPRequest(
      {
        method: "prompts/get" as const,
        params: { name, arguments: args },
      },
      GetPromptResultSchema,
      "prompts",
    );
    setPromptContent(JSON.stringify(response, null, 2));
  };

  const readResource = async (uri: string) => {
    lastToolCallOriginTabRef.current = currentTabRef.current;

    const response = await sendMCPRequest(
      {
        method: "resources/read" as const,
        params: { uri },
      },
      ReadResourceResultSchema,
      "resources",
    );
    const content = JSON.stringify(response, null, 2);
    setResourceContent(content);
    setResourceContentMap((prev) => ({
      ...prev,
      [uri]: content,
    }));
  };

  const subscribeToResource = async (uri: string) => {
    if (!resourceSubscriptions.has(uri)) {
      await sendMCPRequest(
        {
          method: "resources/subscribe" as const,
          params: { uri },
        },
        z.object({}),
        "resources",
      );
      const clone = new Set(resourceSubscriptions);
      clone.add(uri);
      setResourceSubscriptions(clone);
    }
  };

  const unsubscribeFromResource = async (uri: string) => {
    if (resourceSubscriptions.has(uri)) {
      await sendMCPRequest(
        {
          method: "resources/unsubscribe" as const,
          params: { uri },
        },
        z.object({}),
        "resources",
      );
      const clone = new Set(resourceSubscriptions);
      clone.delete(uri);
      setResourceSubscriptions(clone);
    }
  };

  const listPrompts = async () => {
    const response = await sendMCPRequest(
      {
        method: "prompts/list" as const,
        params: nextPromptCursor ? { cursor: nextPromptCursor } : {},
      },
      ListPromptsResultSchema,
      "prompts",
    );
    setPrompts(response.prompts);
    setNextPromptCursor(response.nextCursor);
  };

  const listTools = async () => {
    const response = await sendMCPRequest(
      {
        method: "tools/list" as const,
        params: nextToolCursor ? { cursor: nextToolCursor } : {},
      },
      ListToolsResultSchema,
      "tools",
    );
    setTools(response.tools);
    setNextToolCursor(response.nextCursor);
    cacheToolOutputSchemas(response.tools);
  };

  const callTool = async (
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ success: boolean; result: CompatibilityCallToolResult }> => {
    lastToolCallOriginTabRef.current = currentTabRef.current;

    try {
      // Find the tool schema to clean parameters properly
      const tool = tools.find((t) => t.name === name);
      const cleanedParams = tool?.inputSchema
        ? cleanParams(params, tool.inputSchema as JsonSchemaType)
        : params;

      const response = await sendMCPRequest(
        {
          method: "tools/call" as const,
          params: {
            name,
            arguments: cleanedParams,
            _meta: {
              progressToken: progressTokenRef.current++,
            },
          },
        },
        CompatibilityCallToolResultSchema,
        "tools",
      );

      // [FORK] Check if the successful response still contains an error (some MCP servers return error in content)
      const contentArray = Array.isArray(response?.content)
        ? (response.content as Array<{ type: string; text?: string }>)
        : [];
      const responseText = contentArray
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("");
      if (
        response?.isError &&
        responseText &&
        responseText.toLowerCase().includes("fetch failed") &&
        isCurrentServerN8nWorkflow()
      ) {
        setForkErrorMessage(responseText);
        setShowForkDialog(true);
      }

      setToolResult(response);
      // Clear any validation errors since tool execution completed
      setErrors((prev) => ({ ...prev, tools: null }));
      return { success: !response?.isError, result: response };
    } catch (e) {
      const errorMessage = (e as Error).message ?? String(e);

      // [FORK] Detect "fetch failed" error from n8n workflow MCP server
      if (
        errorMessage.toLowerCase().includes("fetch failed") &&
        isCurrentServerN8nWorkflow()
      ) {
        setForkErrorMessage(errorMessage);
        setShowForkDialog(true);
      }

      const toolResult: CompatibilityCallToolResult = {
        content: [
          {
            type: "text",
            text: errorMessage,
          },
        ],
        isError: true,
      };
      setToolResult(toolResult);
      // Clear validation errors - tool execution errors are shown in ToolResults
      setErrors((prev) => ({ ...prev, tools: null }));
      return { success: false, result: toolResult };
    }
  };

  const handleRootsChange = async () => {
    await sendNotification({ method: "notifications/roots/list_changed" });
  };

  const handleClearNotifications = () => {
    setNotifications([]);
  };

  // Auto-list tools, resources, and prompts when connection is established
  useEffect(() => {
    if (connectionStatus === "connected") {
      if (serverCapabilities?.tools) {
        void listTools();
      }
      if (serverCapabilities?.resources) {
        void listResources();
      }
      if (serverCapabilities?.prompts) {
        void listPrompts();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStatus, serverCapabilities]);

  const sendLogLevelRequest = async (level: LoggingLevel) => {
    await sendMCPRequest(
      {
        method: "logging/setLevel" as const,
        params: { level },
      },
      z.object({}),
    );
    setLogLevel(level);
  };

  const AuthDebuggerWrapper = () => (
    <TabsContent value="auth">
      <AuthDebugger
        serverUrl={sseUrl}
        onBack={() => setIsAuthDebuggerVisible(false)}
        authState={authState}
        updateAuthState={updateAuthState}
      />
    </TabsContent>
  );

  if (window.location.pathname === "/oauth/callback") {
    const OAuthCallback = React.lazy(
      () => import("./components/OAuthCallback"),
    );
    return (
      <Suspense fallback={<div>Loading...</div>}>
        <OAuthCallback onConnect={onOAuthConnect} />
      </Suspense>
    );
  }

  if (window.location.pathname === "/oauth/callback/debug") {
    const OAuthDebugCallback = React.lazy(
      () => import("./components/OAuthDebugCallback"),
    );
    return (
      <Suspense fallback={<div>Loading...</div>}>
        <OAuthDebugCallback onConnect={onOAuthDebugConnect} />
      </Suspense>
    );
  }

  return (
    <>
      <div className="flex h-screen bg-background">
        <div
          style={{
            width: sidebarCollapsed ? 44 : sidebarWidth,
            minWidth: sidebarCollapsed ? 44 : 200,
            maxWidth: sidebarCollapsed ? 44 : 600,
            transition: isSidebarDragging
              ? "none"
              : "width 0.2s ease, min-width 0.2s ease, max-width 0.2s ease",
          }}
          className="bg-card border-r border-border flex flex-col h-full relative"
        >
          {/* Collapse / Expand toggle (top) */}
          <button
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            className="absolute top-3 right-1 z-20 p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            style={{
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {sidebarCollapsed ? (
              <PanelLeft className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>

          {/* Collapse / Expand toggle (center of right border) */}
          <button
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            className="absolute z-20 p-0.5 rounded-full border border-border bg-card hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shadow-sm"
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            style={{
              top: "50%",
              right: -12,
              transform: "translateY(-50%)",
              width: 24,
              height: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {sidebarCollapsed ? (
              <ChevronRight className="w-3.5 h-3.5" />
            ) : (
              <ChevronLeft className="w-3.5 h-3.5" />
            )}
          </button>

          {sidebarCollapsed && (
            <div className="flex flex-col items-center gap-2 mt-12 px-1">
              <button
                onClick={() => {
                  setActiveConfigPath("~/.cursor/mcp.json");
                  localStorage.setItem(
                    "activeConfigPath",
                    "~/.cursor/mcp.json",
                  );
                  setConfigRefreshKey((k) => k + 1);
                }}
                className={`p-1.5 rounded hover:bg-muted transition-colors ${
                  activeConfigPath === "~/.cursor/mcp.json"
                    ? "ring-2 ring-green-500"
                    : ""
                }`}
                title="Cursor"
              >
                <img src="/cursor.svg" alt="Cursor" className="w-5 h-5" />
              </button>
              <button
                onClick={() => {
                  setActiveConfigPath("~/.gemini/antigravity/mcp_config.json");
                  localStorage.setItem(
                    "activeConfigPath",
                    "~/.gemini/antigravity/mcp_config.json",
                  );
                  setConfigRefreshKey((k) => k + 1);
                }}
                className={`p-1.5 rounded hover:bg-muted transition-colors ${
                  activeConfigPath === "~/.gemini/antigravity/mcp_config.json"
                    ? "ring-2 ring-green-500"
                    : ""
                }`}
                title="Antigravity"
              >
                <img
                  src="/antigravity.png"
                  alt="Antigravity"
                  className="w-5 h-5"
                />
              </button>
              <button
                onClick={() => {
                  setActiveConfigPath("~/.codex/config.toml");
                  localStorage.setItem(
                    "activeConfigPath",
                    "~/.codex/config.toml",
                  );
                  setConfigRefreshKey((k) => k + 1);
                }}
                className={`p-1.5 rounded hover:bg-muted transition-colors ${
                  activeConfigPath === "~/.codex/config.toml"
                    ? "ring-2 ring-green-500"
                    : ""
                }`}
                title="Codex"
              >
                <img src="/codex.png" alt="Codex" className="w-5 h-5" />
              </button>
              <button
                onClick={() => {
                  setActiveConfigPath("~/.config/opencode/opencode.json");
                  localStorage.setItem(
                    "activeConfigPath",
                    "~/.config/opencode/opencode.json",
                  );
                  setConfigRefreshKey((k) => k + 1);
                }}
                className={`p-1.5 rounded hover:bg-muted transition-colors ${
                  activeConfigPath === "~/.config/opencode/opencode.json"
                    ? "ring-2 ring-green-500"
                    : ""
                }`}
                title="OpenCode"
              >
                <img src="/opencode.svg" alt="OpenCode" className="w-5 h-5" />
              </button>
            </div>
          )}

          {!sidebarCollapsed && (
            <>
              <Sidebar
                connectionStatus={connectionStatus}
                transportType={transportType}
                setTransportType={setTransportType}
                command={command}
                setCommand={setCommand}
                args={args}
                setArgs={setArgs}
                configFilePath={configFilePath}
                setConfigFilePath={setConfigFilePath}
                sseUrl={sseUrl}
                setSseUrl={setSseUrl}
                env={env}
                setEnv={setEnv}
                config={config}
                setConfig={setConfig}
                customHeaders={customHeaders}
                setCustomHeaders={setCustomHeaders}
                oauthClientId={oauthClientId}
                setOauthClientId={setOauthClientId}
                oauthClientSecret={oauthClientSecret}
                setOauthClientSecret={setOauthClientSecret}
                oauthScope={oauthScope}
                setOauthScope={setOauthScope}
                onConnect={reloadConfigAndReconnect}
                onDisconnect={disconnectMcpServer}
                logLevel={logLevel}
                sendLogLevelRequest={sendLogLevelRequest}
                loggingSupported={!!serverCapabilities?.logging || false}
                onServersChange={setCurrentServers}
                connectionType={connectionType}
                setConnectionType={setConnectionType}
                configRefreshKey={configRefreshKey}
              />
              <div
                onMouseDown={handleSidebarDragStart}
                style={{
                  cursor: "col-resize",
                  position: "absolute",
                  top: 0,
                  right: 0,
                  width: 6,
                  height: "100%",
                  zIndex: 10,
                  background: isSidebarDragging
                    ? "rgba(0,0,0,0.08)"
                    : "transparent",
                }}
                aria-label="Resize sidebar"
                data-testid="sidebar-drag-handle"
              />
            </>
          )}
        </div>
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto">
            {mcpClient ? (
              <Tabs
                value={activeTab}
                className="w-full p-4"
                onValueChange={(value) => {
                  setActiveTab(value);
                  window.location.hash = value;
                }}
              >
                <TabsList className="mb-4 py-0">
                  <TabsTrigger value="store">
                    <Store className="w-4 h-4 mr-2" />
                    MCP Store
                  </TabsTrigger>
                  <TabsTrigger value="credentials">
                    <Shield className="w-4 h-4 mr-2" />
                    Credentials
                    {enabledCredentials.size > 0 && (
                      <Badge
                        variant="secondary"
                        className="ml-1.5 text-xs px-1.5 py-0"
                      >
                        {enabledCredentials.size}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger
                    value="resources"
                    disabled={!serverCapabilities?.resources}
                  >
                    <Files className="w-4 h-4 mr-2" />
                    Resources
                  </TabsTrigger>
                  <TabsTrigger
                    value="prompts"
                    disabled={!serverCapabilities?.prompts}
                  >
                    <MessageSquare className="w-4 h-4 mr-2" />
                    Prompts
                  </TabsTrigger>
                  <TabsTrigger
                    value="tools"
                    disabled={!serverCapabilities?.tools}
                  >
                    <Hammer className="w-4 h-4 mr-2" />
                    Tools
                  </TabsTrigger>
                  <TabsTrigger value="ping">
                    <Bell className="w-4 h-4 mr-2" />
                    Ping
                  </TabsTrigger>
                  <TabsTrigger value="sampling" className="relative">
                    <Hash className="w-4 h-4 mr-2" />
                    Sampling
                    {pendingSampleRequests.length > 0 && (
                      <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-4 w-4 flex items-center justify-center">
                        {pendingSampleRequests.length}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="elicitations" className="relative">
                    <MessageSquare className="w-4 h-4 mr-2" />
                    Elicitations
                    {pendingElicitationRequests.length > 0 && (
                      <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-4 w-4 flex items-center justify-center">
                        {pendingElicitationRequests.length}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="roots">
                    <FolderTree className="w-4 h-4 mr-2" />
                    Roots
                  </TabsTrigger>
                  <TabsTrigger value="auth">
                    <Key className="w-4 h-4 mr-2" />
                    Auth
                  </TabsTrigger>
                  <TabsTrigger value="logger">
                    <FileText className="w-4 h-4 mr-2" />
                    Logger
                  </TabsTrigger>
                </TabsList>

                <div className="w-full">
                  {!serverCapabilities?.resources &&
                  !serverCapabilities?.prompts &&
                  !serverCapabilities?.tools ? (
                    <>
                      <div className="flex items-center justify-center p-4">
                        <p className="text-lg text-gray-500 dark:text-gray-400">
                          The connected server does not support any MCP
                          capabilities
                        </p>
                      </div>
                      <PingTab
                        onPingClick={() => {
                          void sendMCPRequest(
                            {
                              method: "ping" as const,
                            },
                            EmptyResultSchema,
                          );
                        }}
                      />
                    </>
                  ) : (
                    <>
                      <ResourcesTab
                        resources={resources}
                        resourceTemplates={resourceTemplates}
                        listResources={() => {
                          clearError("resources");
                          listResources();
                        }}
                        clearResources={() => {
                          setResources([]);
                          setNextResourceCursor(undefined);
                        }}
                        listResourceTemplates={() => {
                          clearError("resources");
                          listResourceTemplates();
                        }}
                        clearResourceTemplates={() => {
                          setResourceTemplates([]);
                          setNextResourceTemplateCursor(undefined);
                        }}
                        readResource={(uri) => {
                          clearError("resources");
                          readResource(uri);
                        }}
                        selectedResource={selectedResource}
                        setSelectedResource={(resource) => {
                          clearError("resources");
                          setSelectedResource(resource);
                        }}
                        resourceSubscriptionsSupported={
                          serverCapabilities?.resources?.subscribe || false
                        }
                        resourceSubscriptions={resourceSubscriptions}
                        subscribeToResource={(uri) => {
                          clearError("resources");
                          subscribeToResource(uri);
                        }}
                        unsubscribeFromResource={(uri) => {
                          clearError("resources");
                          unsubscribeFromResource(uri);
                        }}
                        handleCompletion={handleCompletion}
                        completionsSupported={completionsSupported}
                        resourceContent={resourceContent}
                        nextCursor={nextResourceCursor}
                        nextTemplateCursor={nextResourceTemplateCursor}
                        error={errors.resources}
                      />
                      <PromptsTab
                        prompts={prompts}
                        listPrompts={() => {
                          clearError("prompts");
                          listPrompts();
                        }}
                        clearPrompts={() => {
                          setPrompts([]);
                          setNextPromptCursor(undefined);
                        }}
                        getPrompt={(name, args) => {
                          clearError("prompts");
                          getPrompt(name, args);
                        }}
                        selectedPrompt={selectedPrompt}
                        setSelectedPrompt={(prompt) => {
                          clearError("prompts");
                          setSelectedPrompt(prompt);
                          setPromptContent("");
                        }}
                        handleCompletion={handleCompletion}
                        completionsSupported={completionsSupported}
                        promptContent={promptContent}
                        nextCursor={nextPromptCursor}
                        error={errors.prompts}
                      />
                      <ToolsTab
                        tools={tools}
                        listTools={() => {
                          clearError("tools");
                          listTools();
                        }}
                        clearTools={() => {
                          setTools([]);
                          setNextToolCursor(undefined);
                          cacheToolOutputSchemas([]);
                        }}
                        callTool={async (name, params) => {
                          clearError("tools");
                          setToolResult(null);
                          return await callTool(name, params);
                        }}
                        selectedTool={selectedTool}
                        setSelectedTool={(tool) => {
                          clearError("tools");
                          setSelectedTool(tool);
                          setToolResult(null);
                        }}
                        toolResult={toolResult}
                        nextCursor={nextToolCursor}
                        error={errors.tools}
                        resourceContent={resourceContentMap}
                        onReadResource={(uri: string) => {
                          clearError("resources");
                          readResource(uri);
                        }}
                        currentServerConfig={serverConfigForCurl}
                        loadedServers={currentServers}
                        config={config}
                      />
                      <ConsoleTab />
                      <PingTab
                        onPingClick={() => {
                          void sendMCPRequest(
                            {
                              method: "ping" as const,
                            },
                            EmptyResultSchema,
                          );
                        }}
                      />
                      <SamplingTab
                        pendingRequests={pendingSampleRequests}
                        onApprove={handleApproveSampling}
                        onReject={handleRejectSampling}
                      />
                      <ElicitationTab
                        pendingRequests={pendingElicitationRequests}
                        onResolve={handleResolveElicitation}
                      />
                      <RootsTab
                        roots={roots}
                        setRoots={setRoots}
                        onRootsChange={handleRootsChange}
                      />
                      <AuthDebuggerWrapper />
                      <TabsContent value="credentials">
                        <CredentialsTab
                          config={config}
                          credentialsFilePath={credentialsFilePath}
                          setCredentialsFilePath={setCredentialsFilePath}
                          enabledCredentials={enabledCredentials}
                          setEnabledCredentials={setEnabledCredentials}
                          rawCredentials={rawCredentials}
                          setRawCredentials={setRawCredentials}
                        />
                      </TabsContent>
                      <TabsContent value="store">
                        <MCPStoreTab
                          config={config}
                          currentServers={currentServers}
                          onServersChange={setCurrentServers}
                          onTestConnection={handleTestConnection}
                          configFilePath={configFilePath}
                          onConfigFileUpdated={() =>
                            setConfigRefreshKey((k) => k + 1)
                          }
                        />
                      </TabsContent>
                      <TabsContent value="logger">
                        <LoggerTab config={config} />
                      </TabsContent>
                    </>
                  )}
                </div>
              </Tabs>
            ) : isAuthDebuggerVisible ? (
              <Tabs
                defaultValue={"auth"}
                className="w-full p-4"
                onValueChange={(value) => (window.location.hash = value)}
              >
                <AuthDebuggerWrapper />
              </Tabs>
            ) : (
              <Tabs
                defaultValue={"store"}
                className="w-full p-4"
                onValueChange={(value) => (window.location.hash = value)}
              >
                <TabsList className="mb-4 py-0">
                  <TabsTrigger value="store">
                    <Store className="w-4 h-4 mr-2" />
                    MCP Store
                  </TabsTrigger>
                  <TabsTrigger value="credentials">
                    <Shield className="w-4 h-4 mr-2" />
                    Credentials
                    {enabledCredentials.size > 0 && (
                      <Badge
                        variant="secondary"
                        className="ml-1.5 text-xs px-1.5 py-0"
                      >
                        {enabledCredentials.size}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="logger">
                    <FileText className="w-4 h-4 mr-2" />
                    Logger
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="credentials">
                  <CredentialsTab
                    config={config}
                    credentialsFilePath={credentialsFilePath}
                    setCredentialsFilePath={setCredentialsFilePath}
                    enabledCredentials={enabledCredentials}
                    setEnabledCredentials={setEnabledCredentials}
                    rawCredentials={rawCredentials}
                    setRawCredentials={setRawCredentials}
                  />
                </TabsContent>
                <TabsContent value="store">
                  <MCPStoreTab
                    config={config}
                    currentServers={currentServers}
                    onServersChange={setCurrentServers}
                    onTestConnection={handleTestConnection}
                    configFilePath={configFilePath}
                    onConfigFileUpdated={() =>
                      setConfigRefreshKey((k) => k + 1)
                    }
                  />
                </TabsContent>
                <TabsContent value="logger">
                  <LoggerTab config={config} />
                </TabsContent>
              </Tabs>
            )}
          </div>
          {activeTab !== "credentials" &&
            activeTab !== "store" &&
            activeTab !== "logger" && (
              <div
                className="relative border-t border-border"
                style={{
                  height: `${historyPaneHeight}px`,
                }}
              >
                <div
                  className="absolute w-full h-4 -top-2 cursor-row-resize flex items-center justify-center hover:bg-accent/50 dark:hover:bg-input/40"
                  onMouseDown={handleDragStart}
                >
                  <div className="w-8 h-1 rounded-full bg-border" />
                </div>
                <div className="h-full overflow-auto">
                  <HistoryAndNotifications
                    requestHistory={requestHistory}
                    serverNotifications={notifications}
                    onClearHistory={clearRequestHistory}
                    onClearNotifications={handleClearNotifications}
                  />
                </div>
              </div>
            )}
        </div>
      </div>
      <Dialog
        open={!!crashError}
        onOpenChange={(open) => {
          if (!open) setCrashError(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-destructive">
              MCP Server Process Crashed
            </DialogTitle>
            <DialogDescription>
              The MCP server process exited with an error. You can select and
              copy the error below.
            </DialogDescription>
          </DialogHeader>
          <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-4 text-sm font-mono whitespace-pre-wrap break-words select-text cursor-text">
            {crashError}
          </pre>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                if (crashError) {
                  navigator.clipboard.writeText(crashError);
                  toast({
                    title: "Copied",
                    description: "Error copied to clipboard",
                  });
                }
              }}
            >
              Copy Error
            </Button>
            {configFilePath && (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    const baseUrl = getMCPProxyAddress(config);
                    const { token, header } = getMCPProxyAuthToken(config);
                    await fetch(
                      `${baseUrl}/open-config-file?path=${encodeURIComponent(configFilePath)}`,
                      {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          [header]: token ? `Bearer ${token}` : "",
                        },
                      },
                    );
                  } catch (err) {
                    console.error("Failed to open config file:", err);
                  }
                }}
              >
                Open MCP Config
              </Button>
            )}
            <DialogClose asChild>
              <Button
                variant="default"
                onClick={() => {
                  setCrashError(null);
                  console.log(
                    "[App] Reconnect clicked — reloading config and reconnecting",
                  );
                  reloadConfigAndReconnect();
                }}
              >
                Reconnect
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* [FORK] Switch to Fork dialog for n8n workflow servers */}
      <Dialog
        open={showForkDialog}
        onOpenChange={(open) => {
          if (!open) {
            console.log("[App:fork] Fork dialog dismissed");
            setShowForkDialog(false);
            setForkErrorMessage(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitFork className="w-5 h-5 text-orange-500" />
              Switch to Fork Server?
            </DialogTitle>
            <DialogDescription>
              The n8n workflow tool call failed with a network error. This
              usually means the n8n server is not reachable. You can switch to
              the local fork server to resolve this.
            </DialogDescription>
          </DialogHeader>
          {forkErrorMessage && (
            <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-muted p-3 text-sm font-mono whitespace-pre-wrap break-words select-text cursor-text">
              {forkErrorMessage}
            </pre>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="default"
              onClick={() => {
                console.log("[App:fork] User clicked Switch to Fork button");
                handleSwitchToFork();
              }}
            >
              <GitFork className="w-4 h-4 mr-2" />
              Switch to Fork
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default App;
