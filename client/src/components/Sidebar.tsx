import { useState, useCallback, useEffect, useRef } from "react";
import {
  Play,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Bug,
  Github,
  Eye,
  EyeOff,
  RotateCcw,
  Settings,
  HelpCircle,
  RefreshCwOff,
  Copy,
  CheckCheck,
  Loader2,
  FileCog,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LoggingLevel,
  LoggingLevelSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InspectorConfig } from "@/lib/configurationTypes";
import {
  getMCPProxyAddress,
  getMCPProxyAuthToken,
  getServerConfigUrl,
  getServerConfigUrlSource,
  redactUrlForLog,
} from "@/utils/configUtils";
import { ConnectionStatus } from "@/lib/constants";
import useTheme from "../lib/hooks/useTheme";
import { version } from "../../../package.json";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import CustomHeaders from "./CustomHeaders";
import { CustomHeaders as CustomHeadersType } from "@/lib/types/customHeaders";
import { useToast } from "../lib/hooks/useToast";
import {
  copyToClipboard,
  getClipboardErrorMessage,
} from "@/utils/clipboardUtils";

interface SidebarProps {
  connectionStatus: ConnectionStatus;
  transportType: "stdio" | "sse" | "streamable-http";
  setTransportType: (type: "stdio" | "sse" | "streamable-http") => void;
  command: string;
  setCommand: (command: string) => void;
  args: string;
  setArgs: (args: string) => void;
  configFilePath: string;
  setConfigFilePath: (path: string) => void;
  sseUrl: string;
  setSseUrl: (url: string) => void;
  env: Record<string, string>;
  setEnv: (env: Record<string, string>) => void;
  // Custom headers support
  customHeaders: CustomHeadersType;
  setCustomHeaders: (headers: CustomHeadersType) => void;
  oauthClientId: string;
  setOauthClientId: (id: string) => void;
  oauthClientSecret: string;
  setOauthClientSecret: (secret: string) => void;
  oauthScope: string;
  setOauthScope: (scope: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  logLevel: LoggingLevel;
  sendLogLevelRequest: (level: LoggingLevel) => void;
  loggingSupported: boolean;
  config: InspectorConfig;
  setConfig: (config: InspectorConfig) => void;
  onServersChange?: (servers: Record<string, any>) => void;
  connectionType: "direct" | "proxy";
  setConnectionType: (type: "direct" | "proxy") => void;
  configRefreshKey?: number;
}

const Sidebar = ({
  connectionStatus,
  transportType,
  setTransportType,
  command,
  setCommand,
  args,
  setArgs,
  configFilePath: _configFilePath,
  setConfigFilePath,
  sseUrl,
  setSseUrl,
  env,
  setEnv,
  customHeaders,
  setCustomHeaders,
  oauthClientId,
  setOauthClientId,
  oauthScope,
  setOauthScope,
  onConnect,
  onDisconnect,
  logLevel,
  sendLogLevelRequest,
  loggingSupported,
  config,
  setConfig,
  onServersChange,
  configRefreshKey,
}: SidebarProps) => {
  const [theme, setTheme] = useTheme();
  const [activeTab, setActiveTab] = useState<"file" | "manual">("file");
  const [showEnvVars, setShowEnvVars] = useState(false);
  const [showAuthConfig, setShowAuthConfig] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [shownEnvVars, setShownEnvVars] = useState<Set<string>>(new Set());
  const [copiedServerEntry, setCopiedServerEntry] = useState(false);
  const [copiedServerFile, setCopiedServerFile] = useState(false);
  const [loadedServers, setLoadedServers] = useState<Record<string, any>>({});
  const [selectedServer, setSelectedServer] = useState<string>("");
  const [isLoadingDefault, setIsLoadingDefault] = useState<boolean>(false);
  const [configCounts, setConfigCounts] = useState<Record<string, number>>({});
  const [activeConfigPath, setActiveConfigPath] = useState<string>(
    () => localStorage.getItem("activeConfigPath") || "",
  );
  const hasLoadedConfig = useRef(false);
  const { toast } = useToast();

  // Apply server configuration to the form
  const applyServerConfig = useCallback(
    (serverConfig: any) => {
      const serverUrl = getServerConfigUrl(serverConfig);
      const serverUrlSource = getServerConfigUrlSource(serverConfig);
      console.log("Applying server configuration:", {
        type: serverConfig?.type,
        hasCommand: Boolean(serverConfig?.command),
        keys: Object.keys(serverConfig || {}),
        serverUrlSource,
        serverUrl: redactUrlForLog(serverUrl),
      });

      if (serverConfig.command) {
        console.log(
          "Detected STDIO server with command:",
          serverConfig.command,
        );
        setTransportType("stdio");
        setCommand(serverConfig.command);
        setArgs(serverConfig.args ? serverConfig.args.join(" ") : "");
        if (serverConfig.env) {
          console.log("Setting environment variables:", serverConfig.env);
          setEnv(serverConfig.env);
        }
      } else if (serverConfig.type === "streamable-http") {
        console.log(
          "Detected Streamable HTTP server with URL:",
          redactUrlForLog(serverUrl),
          "source:",
          serverUrlSource,
        );
        setTransportType("streamable-http");
        setSseUrl(serverUrl);
      } else if (serverConfig.type === "sse" || serverUrl) {
        console.log(
          "Detected SSE server with URL:",
          redactUrlForLog(serverUrl),
          "source:",
          serverUrlSource,
        );
        setTransportType("sse");
        setSseUrl(serverUrl);
      } else {
        console.warn("Unknown server configuration type:", serverConfig);
        console.warn("Server config does not match expected patterns");
      }
    },
    [setTransportType, setCommand, setArgs, setEnv, setSseUrl],
  );

  // Handle server selection change
  const handleServerSelection = useCallback(
    (serverName: string) => {
      console.log("Server selection changed to:", serverName);
      console.log("Available servers:", Object.keys(loadedServers));
      setSelectedServer(serverName);
      if (loadedServers[serverName]) {
        console.log("Applying configuration for selected server:", serverName);
        applyServerConfig(loadedServers[serverName]);
      } else {
        console.error(
          "Selected server not found in loaded servers:",
          serverName,
        );
      }
    },
    [loadedServers, applyServerConfig],
  );

  // Attempt to load configuration file via server endpoint
  // If configPath is provided, it will be passed as ?path= query param;
  // otherwise the server defaults to ~/.cursor/mcp.json
  const loadDefaultConfig = useCallback(
    async (configPath?: string) => {
      setIsLoadingDefault(true);
      try {
        console.log(
          "Attempting to load configuration from server /mcp-config",
          configPath ? `(path=${configPath})` : "(default)",
        );

        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);
        const url = configPath
          ? `${baseUrl}/mcp-config?path=${encodeURIComponent(configPath)}`
          : `${baseUrl}/mcp-config`;

        const resp = await fetch(url, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          console.error("Failed to load MCP config:", err);
          if (configPath) {
            toast({
              title: "Error",
              description: `Failed to load config from ${configPath}: ${err.message || resp.statusText}`,
              variant: "destructive",
            });
          }
          return;
        }

        const data = await resp.json();
        console.log("MCP config loaded:", data);
        console.log("data.path:", data.path);
        console.log("resp.ok:", resp.ok);

        const configData = data.config as any;
        console.log("configData:", configData);
        const servers = (configData.servers || configData.mcpServers) as
          | Record<string, any>
          | undefined;
        console.log("servers:", servers);

        if (typeof data.path === "string" && data.path) {
          console.log("Setting configFilePath to:", data.path);
          hasLoadedConfig.current = true;
          setConfigFilePath(data.path);
        } else {
          console.warn("data.path is not a valid string:", data.path);
        }

        if (!servers || Object.keys(servers).length === 0) {
          console.log("No servers found, clearing loadedServers");
          setLoadedServers({});
          setSelectedServer("");
          if (configPath) {
            setConfigCounts((prev) => ({ ...prev, [configPath]: 0 }));
          }
          return;
        }

        setLoadedServers(servers);
        const names = Object.keys(servers);
        if (names.length > 0) {
          setSelectedServer(names[0]);
          applyServerConfig(servers[names[0]]);
        }

        if (configPath) {
          setConfigCounts((prev) => ({ ...prev, [configPath]: names.length }));
        }
      } catch (error) {
        console.error("Error loading config:", error);
        if (configPath) {
          toast({
            title: "Error",
            description: `Failed to load config: ${error instanceof Error ? error.message : String(error)}`,
            variant: "destructive",
          });
        }
      } finally {
        setIsLoadingDefault(false);
      }
    },
    [config, applyServerConfig, setConfigFilePath, toast],
  );

  // Fetch server counts for known config paths on mount
  const CONFIG_PATHS = [
    "~/.cursor/mcp.json",
    "~/.gemini/antigravity/mcp_config.json",
    "~/.codex/config.toml",
    "~/.config/opencode/opencode.json",
  ];

  useEffect(() => {
    const fetchCounts = async () => {
      const baseUrl = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      const counts: Record<string, number> = {};

      // Include custom activeConfigPath if it's not already in CONFIG_PATHS
      const pathsToFetch = [...CONFIG_PATHS];
      if (activeConfigPath && !CONFIG_PATHS.includes(activeConfigPath)) {
        pathsToFetch.push(activeConfigPath);
      }

      for (const cfgPath of pathsToFetch) {
        try {
          const url = `${baseUrl}/mcp-config?path=${encodeURIComponent(cfgPath)}`;
          const resp = await fetch(url, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              [header]: token ? `Bearer ${token}` : "",
            },
          });
          if (resp.ok) {
            const data = await resp.json();
            counts[cfgPath] = data.serverCount ?? 0;
          }
        } catch {
          // silently ignore
        }
      }

      setConfigCounts(counts);
    };

    fetchCounts();
  }, [config, activeConfigPath]);

  // Auto-load default configuration on component mount (once only)
  useEffect(() => {
    if (!hasLoadedConfig.current) {
      const savedConfigPath = localStorage.getItem("activeConfigPath");
      loadDefaultConfig(savedConfigPath || undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh config data when configRefreshKey changes (triggered by MCP Store install/uninstall)
  useEffect(() => {
    if (configRefreshKey && configRefreshKey > 0) {
      console.log(
        "[Sidebar] configRefreshKey changed, re-fetching config and counts",
        { configRefreshKey, _configFilePath },
      );

      const refreshAll = async () => {
        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);
        const authHeaders = {
          "Content-Type": "application/json",
          [header]: token ? `Bearer ${token}` : "",
        };
        console.log("[Sidebar refreshAll] baseUrl:", baseUrl);

        // 1) Silently re-load the current config file to refresh loadedServers
        if (_configFilePath) {
          try {
            // Find the matching tilde path, or use the full path as-is
            const configPathParam =
              CONFIG_PATHS.find((cp) =>
                _configFilePath.endsWith(cp.replace("~", "")),
              ) || _configFilePath;

            console.log(
              "[Sidebar refreshAll] _configFilePath:",
              _configFilePath,
            );
            console.log(
              "[Sidebar refreshAll] resolved configPathParam:",
              configPathParam,
            );

            const url = `${baseUrl}/mcp-config?path=${encodeURIComponent(configPathParam)}`;
            console.log("[Sidebar refreshAll] fetching config from:", url);

            const resp = await fetch(url, {
              method: "GET",
              headers: authHeaders,
            });
            console.log(
              "[Sidebar refreshAll] config response status:",
              resp.status,
              resp.statusText,
            );

            if (resp.ok) {
              const data = await resp.json();
              console.log("[Sidebar refreshAll] config response data:", data);

              const configData = data.config as any;
              const servers = (configData.servers || configData.mcpServers) as
                | Record<string, any>
                | undefined;

              console.log(
                "[Sidebar refreshAll] parsed servers:",
                servers ? Object.keys(servers) : "none",
              );

              if (servers && Object.keys(servers).length > 0) {
                console.log(
                  "[Sidebar refreshAll] setting loadedServers:",
                  Object.keys(servers),
                );
                setLoadedServers(servers);
                // Keep current selection if it still exists, otherwise select first
                const names = Object.keys(servers);
                setSelectedServer((prev) => {
                  const next = names.includes(prev) ? prev : names[0] || "";
                  console.log(
                    "[Sidebar refreshAll] selectedServer:",
                    prev,
                    "->",
                    next,
                  );
                  return next;
                });
              } else {
                console.log("[Sidebar refreshAll] no servers found, clearing");
                setLoadedServers({});
                setSelectedServer("");
              }
            } else {
              console.warn(
                "[Sidebar refreshAll] config fetch failed:",
                resp.status,
                resp.statusText,
              );
            }
          } catch (err) {
            console.error(
              "[Sidebar refreshAll] error refreshing loadedServers:",
              err,
            );
          }
        } else {
          console.log(
            "[Sidebar refreshAll] skipping config refresh, no _configFilePath",
          );
        }

        // 2) Re-fetch server counts for all known config paths
        // Include custom activeConfigPath if not already in CONFIG_PATHS
        const pathsToFetch = [...CONFIG_PATHS];
        if (activeConfigPath && !CONFIG_PATHS.includes(activeConfigPath)) {
          pathsToFetch.push(activeConfigPath);
        }
        console.log(
          "[Sidebar refreshAll] fetching counts for paths:",
          pathsToFetch,
        );
        const counts: Record<string, number> = {};
        for (const cfgPath of pathsToFetch) {
          try {
            const url = `${baseUrl}/mcp-config?path=${encodeURIComponent(cfgPath)}`;
            console.log(
              "[Sidebar refreshAll] fetching count for:",
              cfgPath,
              "url:",
              url,
            );
            const resp = await fetch(url, {
              method: "GET",
              headers: authHeaders,
            });
            console.log(
              "[Sidebar refreshAll] count response for",
              cfgPath,
              ":",
              resp.status,
            );
            if (resp.ok) {
              const data = await resp.json();
              counts[cfgPath] = data.serverCount ?? 0;
              console.log(
                "[Sidebar refreshAll] count for",
                cfgPath,
                "=",
                counts[cfgPath],
              );
            } else {
              console.warn(
                "[Sidebar refreshAll] count fetch failed for",
                cfgPath,
                ":",
                resp.status,
              );
            }
          } catch (err) {
            console.error(
              "[Sidebar refreshAll] count fetch error for",
              cfgPath,
              ":",
              err,
            );
          }
        }

        console.log("[Sidebar refreshAll] final configCounts:", counts);
        setConfigCounts(counts);
        console.log("[Sidebar refreshAll] done");
      };

      refreshAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configRefreshKey]);

  // Notify parent when servers change
  useEffect(() => {
    if (onServersChange) {
      onServersChange(loadedServers);
    }
  }, [loadedServers, onServersChange]);

  // Shared utility function to generate server config
  const generateServerConfig = useCallback(() => {
    if (transportType === "stdio") {
      return {
        command,
        args: args.trim() ? args.split(/\s+/) : [],
        env: { ...env },
      };
    }
    if (transportType === "sse") {
      return {
        type: "sse",
        url: sseUrl,
        note: "For SSE connections, add this URL directly in your MCP Client",
      };
    }
    if (transportType === "streamable-http") {
      return {
        type: "streamable-http",
        url: sseUrl,
        note: "For Streamable HTTP connections, add this URL directly in your MCP Client",
      };
    }
    return {};
  }, [transportType, command, args, env, sseUrl]);

  // Memoized config entry generator
  const generateMCPServerEntry = useCallback(() => {
    return JSON.stringify(generateServerConfig(), null, 4);
  }, [generateServerConfig]);

  // Memoized config file generator
  const generateMCPServerFile = useCallback(() => {
    return JSON.stringify(
      {
        mcpServers: {
          "default-server": generateServerConfig(),
        },
      },
      null,
      4,
    );
  }, [generateServerConfig]);

  // Memoized copy handlers
  const handleCopyServerEntry = useCallback(async () => {
    try {
      const configJson = generateMCPServerEntry();
      const result = await copyToClipboard(configJson);

      if (result.success) {
        setCopiedServerEntry(true);

        toast({
          title: "Config entry copied",
          description:
            transportType === "stdio"
              ? "Server configuration has been copied to clipboard. Add this to your mcp.json inside the 'mcpServers' object with your preferred server name."
              : transportType === "streamable-http"
                ? "Streamable HTTP URL has been copied. Use this URL directly in your MCP Client."
                : "SSE URL has been copied. Use this URL directly in your MCP Client.",
        });

        setTimeout(() => {
          setCopiedServerEntry(false);
        }, 2000);
      } else {
        toast({
          title: "Error",
          description: getClipboardErrorMessage(
            result.error || "Unknown error",
          ),
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: getClipboardErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
        variant: "destructive",
      });
    }
  }, [generateMCPServerEntry, transportType, toast]);

  const handleCopyServerFile = useCallback(async () => {
    try {
      const configJson = generateMCPServerFile();
      const result = await copyToClipboard(configJson);

      if (result.success) {
        setCopiedServerFile(true);

        toast({
          title: "Servers file copied",
          description:
            "Servers configuration has been copied to clipboard. Add this to your mcp.json file. Current testing server will be added as 'default-server'",
        });

        setTimeout(() => {
          setCopiedServerFile(false);
        }, 2000);
      } else {
        toast({
          title: "Error",
          description: getClipboardErrorMessage(
            result.error || "Unknown error",
          ),
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: getClipboardErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
        variant: "destructive",
      });
    }
  }, [generateMCPServerFile, toast]);

  console.log(
    "[Sidebar RENDER] configCounts:",
    configCounts,
    "loadedServers keys:",
    Object.keys(loadedServers),
    "selectedServer:",
    selectedServer,
  );

  const configBtnClass = "flex items-center gap-1.5 px-[10px]";

  return (
    <div className="bg-card border-r border-border flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-border">
        <div className="flex items-center">
          <h1 className="ml-2 text-lg font-semibold">
            MCP Inspector v{version}
          </h1>
        </div>
      </div>

      <div className="p-4 flex-1 overflow-auto">
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as "file" | "manual")}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="file">MCP File</TabsTrigger>
            <TabsTrigger value="manual">Manual</TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="space-y-4 mt-4">
            {/* Configuration Buttons */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Load Configuration</label>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setActiveConfigPath("~/.cursor/mcp.json");
                    localStorage.setItem(
                      "activeConfigPath",
                      "~/.cursor/mcp.json",
                    );
                    loadDefaultConfig("~/.cursor/mcp.json");
                  }}
                  disabled={isLoadingDefault}
                  className={`${configBtnClass} ${activeConfigPath === "~/.cursor/mcp.json" ? "ring-2 ring-green-500" : ""}`}
                >
                  {isLoadingDefault ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <img src="/cursor.svg" alt="Cursor" className="w-4 h-4" />
                  )}
                  Cursor
                  {configCounts["~/.cursor/mcp.json"] != null
                    ? ` (${configCounts["~/.cursor/mcp.json"]})`
                    : ""}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setActiveConfigPath(
                      "~/.gemini/antigravity/mcp_config.json",
                    );
                    localStorage.setItem(
                      "activeConfigPath",
                      "~/.gemini/antigravity/mcp_config.json",
                    );
                    loadDefaultConfig("~/.gemini/antigravity/mcp_config.json");
                  }}
                  disabled={isLoadingDefault}
                  className={`${configBtnClass} ${activeConfigPath === "~/.gemini/antigravity/mcp_config.json" ? "ring-2 ring-green-500" : ""}`}
                >
                  {isLoadingDefault ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <img
                      src="/antigravity.png"
                      alt="Antigravity"
                      className="w-4 h-4"
                    />
                  )}
                  Antigravity
                  {configCounts["~/.gemini/antigravity/mcp_config.json"] != null
                    ? ` (${configCounts["~/.gemini/antigravity/mcp_config.json"]})`
                    : ""}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setActiveConfigPath("~/.codex/config.toml");
                    localStorage.setItem(
                      "activeConfigPath",
                      "~/.codex/config.toml",
                    );
                    loadDefaultConfig("~/.codex/config.toml");
                  }}
                  disabled={isLoadingDefault}
                  className={`${configBtnClass} ${activeConfigPath === "~/.codex/config.toml" ? "ring-2 ring-green-500" : ""}`}
                >
                  {isLoadingDefault ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <img src="/codex.png" alt="Codex" className="w-4 h-4" />
                  )}
                  Codex
                  {configCounts["~/.codex/config.toml"] != null
                    ? ` (${configCounts["~/.codex/config.toml"]})`
                    : ""}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setActiveConfigPath("~/.config/opencode/opencode.json");
                    localStorage.setItem(
                      "activeConfigPath",
                      "~/.config/opencode/opencode.json",
                    );
                    loadDefaultConfig("~/.config/opencode/opencode.json");
                  }}
                  disabled={isLoadingDefault}
                  className={`${configBtnClass} ${activeConfigPath === "~/.config/opencode/opencode.json" ? "ring-2 ring-green-500" : ""}`}
                >
                  {isLoadingDefault ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <img
                      src="/opencode.svg"
                      alt="OpenCode"
                      className="w-4 h-4"
                    />
                  )}
                  OpenCode
                  {configCounts["~/.config/opencode/opencode.json"] != null
                    ? ` (${configCounts["~/.config/opencode/opencode.json"]})`
                    : ""}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      const baseUrl = getMCPProxyAddress(config);
                      const { token, header } = getMCPProxyAuthToken(config);
                      const resp = await fetch(`${baseUrl}/choose-file`, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          [header]: token ? `Bearer ${token}` : "",
                        },
                      });
                      if (resp.ok) {
                        const data = await resp.json();
                        if (!data.cancelled && data.path) {
                          console.log(
                            "[Custom] File chosen:",
                            data.path,
                            data.absolutePath,
                          );
                          setActiveConfigPath(data.path);
                          localStorage.setItem("activeConfigPath", data.path);
                          loadDefaultConfig(data.path);
                        }
                      }
                    } catch (err) {
                      console.error("[Custom] Error choosing file:", err);
                    }
                  }}
                  disabled={isLoadingDefault}
                  className={`${configBtnClass} ${activeConfigPath && activeConfigPath !== "~/.cursor/mcp.json" && activeConfigPath !== "~/.gemini/antigravity/mcp_config.json" && activeConfigPath !== "~/.codex/config.toml" && activeConfigPath !== "~/.config/opencode/opencode.json" ? "ring-2 ring-green-500" : ""}`}
                >
                  {isLoadingDefault ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FileCog className="w-4 h-4" />
                  )}
                  Custom
                  {activeConfigPath &&
                  activeConfigPath !== "~/.cursor/mcp.json" &&
                  activeConfigPath !==
                    "~/.gemini/antigravity/mcp_config.json" &&
                  activeConfigPath !== "~/.codex/config.toml" &&
                  activeConfigPath !== "~/.config/opencode/opencode.json" &&
                  configCounts[activeConfigPath] != null
                    ? ` (${configCounts[activeConfigPath]})`
                    : ""}
                </Button>
              </div>
              {_configFilePath && !isLoadingDefault && (
                <button
                  className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700 hover:underline cursor-pointer truncate max-w-full text-left"
                  title="Open config file"
                  onClick={async () => {
                    try {
                      const baseUrl = getMCPProxyAddress(config);
                      const { token, header } = getMCPProxyAuthToken(config);
                      const tilePath =
                        CONFIG_PATHS.find((cp) =>
                          _configFilePath.endsWith(cp.replace("~", "")),
                        ) || _configFilePath;
                      await fetch(
                        `${baseUrl}/open-config-file?path=${encodeURIComponent(tilePath)}`,
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
                  <FileText className="w-3 h-3 shrink-0" />
                  <span className="truncate">{_configFilePath}</span>
                </button>
              )}
            </div>

            {/* Server Selection Dropdown */}
            {Object.keys(loadedServers).length > 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="server-select">
                  Select MCP Server
                </label>
                <Select
                  value={selectedServer}
                  onValueChange={handleServerSelection}
                >
                  <SelectTrigger id="server-select">
                    <SelectValue placeholder="Select a server" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(loadedServers).map((serverName) => (
                      <SelectItem key={serverName} value={serverName}>
                        {serverName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Choose which server configuration to use
                </p>
                <div className="flex gap-2">
                  {connectionStatus === "connected" ? (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={onDisconnect}
                    >
                      <RotateCcw className="w-4 h-4 mr-2" />
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      onClick={onConnect}
                      disabled={
                        !selectedServer || connectionStatus === "connecting"
                      }
                    >
                      {connectionStatus === "connecting" ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Play className="w-4 h-4 mr-2" />
                      )}
                      {connectionStatus === "connecting"
                        ? "Connecting..."
                        : "Connect"}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="manual" className="space-y-4 mt-4">
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="transport-type-select"
              >
                Transport Type
              </label>
              <Select
                value={transportType}
                onValueChange={(value: "stdio" | "sse" | "streamable-http") =>
                  setTransportType(value)
                }
              >
                <SelectTrigger id="transport-type-select">
                  <SelectValue placeholder="Select transport type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">STDIO</SelectItem>
                  <SelectItem value="sse">SSE</SelectItem>
                  <SelectItem value="streamable-http">
                    Streamable HTTP
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {transportType === "stdio" ? (
              <>
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="command-input"
                  >
                    Command
                  </label>
                  <Input
                    id="command-input"
                    placeholder="Command"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onBlur={(e) => setCommand(e.target.value.trim())}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="arguments-input"
                  >
                    Arguments
                  </label>
                  <Input
                    id="arguments-input"
                    placeholder="Arguments (space-separated)"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    className="font-mono"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="sse-url-input"
                  >
                    URL
                  </label>
                  {sseUrl ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Input
                          id="sse-url-input"
                          placeholder="URL"
                          value={sseUrl}
                          onChange={(e) => setSseUrl(e.target.value)}
                          className="font-mono"
                        />
                      </TooltipTrigger>
                      <TooltipContent>{sseUrl}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Input
                      id="sse-url-input"
                      placeholder="URL"
                      value={sseUrl}
                      onChange={(e) => setSseUrl(e.target.value)}
                      className="font-mono"
                    />
                  )}
                </div>
              </>
            )}

            {transportType === "stdio" && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  onClick={() => setShowEnvVars(!showEnvVars)}
                  className="flex items-center w-full"
                  data-testid="env-vars-button"
                  aria-expanded={showEnvVars}
                >
                  {showEnvVars ? (
                    <ChevronDown className="w-4 h-4 mr-2" />
                  ) : (
                    <ChevronRight className="w-4 h-4 mr-2" />
                  )}
                  Environment Variables
                </Button>
                {showEnvVars && (
                  <div className="space-y-2">
                    {Object.entries(env).map(([key, value], idx) => (
                      <div key={idx} className="space-y-2 pb-4">
                        <div className="flex gap-2">
                          <Input
                            aria-label={`Environment variable key ${idx + 1}`}
                            placeholder="Key"
                            value={key}
                            onChange={(e) => {
                              const newKey = e.target.value;
                              const newEnv = Object.entries(env).reduce(
                                (acc, [k, v]) => {
                                  if (k === key) {
                                    acc[newKey] = value;
                                  } else {
                                    acc[k] = v;
                                  }
                                  return acc;
                                },
                                {} as Record<string, string>,
                              );
                              setEnv(newEnv);
                              setShownEnvVars((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) {
                                  next.delete(key);
                                  next.add(newKey);
                                }
                                return next;
                              });
                            }}
                            className="font-mono"
                          />
                          <Button
                            variant="destructive"
                            size="icon"
                            className="h-9 w-9 p-0 shrink-0"
                            onClick={() => {
                              // eslint-disable-next-line @typescript-eslint/no-unused-vars
                              const { [key]: _removed, ...rest } = env;
                              setEnv(rest);
                            }}
                          >
                            ×
                          </Button>
                        </div>
                        <div className="flex gap-2">
                          <Input
                            aria-label={`Environment variable value ${idx + 1}`}
                            type={shownEnvVars.has(key) ? "text" : "password"}
                            placeholder="Value"
                            value={value}
                            onChange={(e) => {
                              const newEnv = { ...env };
                              newEnv[key] = e.target.value;
                              setEnv(newEnv);
                            }}
                            className="font-mono"
                          />
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-9 w-9 p-0 shrink-0"
                            onClick={() => {
                              setShownEnvVars((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) {
                                  next.delete(key);
                                } else {
                                  next.add(key);
                                }
                                return next;
                              });
                            }}
                            aria-label={
                              shownEnvVars.has(key)
                                ? "Hide value"
                                : "Show value"
                            }
                            aria-pressed={shownEnvVars.has(key)}
                            title={
                              shownEnvVars.has(key)
                                ? "Hide value"
                                : "Show value"
                            }
                          >
                            {shownEnvVars.has(key) ? (
                              <Eye className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <EyeOff className="h-4 w-4" aria-hidden="true" />
                            )}
                          </Button>
                        </div>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      className="w-full mt-2"
                      onClick={() => {
                        const key = "";
                        const newEnv = { ...env };
                        newEnv[key] = "";
                        setEnv(newEnv);
                      }}
                    >
                      Add Environment Variable
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Always show both copy buttons for all transport types */}
            <div className="grid grid-cols-2 gap-2 mt-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyServerEntry}
                    className="w-full"
                  >
                    {copiedServerEntry ? (
                      <CheckCheck className="h-4 w-4 mr-2" />
                    ) : (
                      <Copy className="h-4 w-4 mr-2" />
                    )}
                    Server Entry
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy Server Entry</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyServerFile}
                    className="w-full"
                  >
                    {copiedServerFile ? (
                      <CheckCheck className="h-4 w-4 mr-2" />
                    ) : (
                      <Copy className="h-4 w-4 mr-2" />
                    )}
                    Servers File
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy Servers File</TooltipContent>
              </Tooltip>
            </div>

            <div className="space-y-2">
              <Button
                variant="outline"
                onClick={() => setShowAuthConfig(!showAuthConfig)}
                className="flex items-center w-full"
                data-testid="auth-button"
                aria-expanded={showAuthConfig}
              >
                {showAuthConfig ? (
                  <ChevronDown className="w-4 h-4 mr-2" />
                ) : (
                  <ChevronRight className="w-4 h-4 mr-2" />
                )}
                Authentication
              </Button>
              {showAuthConfig && (
                <>
                  {/* Custom Headers Section */}
                  <div className="p-3 rounded border overflow-hidden">
                    <CustomHeaders
                      headers={customHeaders}
                      onChange={setCustomHeaders}
                    />
                  </div>
                  {transportType !== "stdio" && (
                    // OAuth Configuration
                    <div className="space-y-2 p-3  rounded border">
                      <h4 className="text-sm font-semibold flex items-center">
                        OAuth 2.0 Flow
                      </h4>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Client ID</label>
                        <Input
                          placeholder="Client ID"
                          onChange={(e) => setOauthClientId(e.target.value)}
                          value={oauthClientId}
                          data-testid="oauth-client-id-input"
                          className="font-mono"
                        />
                        <label className="text-sm font-medium">
                          Redirect URL
                        </label>
                        <Input
                          readOnly
                          placeholder="Redirect URL"
                          value={window.location.origin + "/oauth/callback"}
                          className="font-mono"
                        />
                        <label className="text-sm font-medium">Scope</label>
                        <Input
                          placeholder="Scope (space-separated)"
                          onChange={(e) => setOauthScope(e.target.value)}
                          value={oauthScope}
                          data-testid="oauth-scope-input"
                          className="font-mono"
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            {/* Configuration */}
            <div className="space-y-2">
              <Button
                variant="outline"
                onClick={() => setShowConfig(!showConfig)}
                className="flex items-center w-full"
                data-testid="config-button"
                aria-expanded={showConfig}
              >
                {showConfig ? (
                  <ChevronDown className="w-4 h-4 mr-2" />
                ) : (
                  <ChevronRight className="w-4 h-4 mr-2" />
                )}
                <Settings className="w-4 h-4 mr-2" />
                Configuration
              </Button>
              {showConfig && (
                <div className="space-y-2">
                  {Object.entries(config).map(([key, configItem]) => {
                    const configKey = key as keyof InspectorConfig;
                    return (
                      <div key={key} className="space-y-2">
                        <div className="flex items-center gap-1">
                          <label
                            className="text-sm font-medium text-green-600 break-all"
                            htmlFor={`${configKey}-input`}
                          >
                            {configItem.label}
                          </label>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <HelpCircle className="h-4 w-4 text-muted-foreground" />
                            </TooltipTrigger>
                            <TooltipContent>
                              {configItem.description}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        {typeof configItem.value === "number" ? (
                          <Input
                            id={`${configKey}-input`}
                            type="number"
                            data-testid={`${configKey}-input`}
                            value={configItem.value}
                            onChange={(e) => {
                              const newConfig = { ...config };
                              newConfig[configKey] = {
                                ...configItem,
                                value: Number(e.target.value),
                              };
                              setConfig(newConfig);
                            }}
                            className="font-mono"
                          />
                        ) : typeof configItem.value === "boolean" ? (
                          <Select
                            data-testid={`${configKey}-select`}
                            value={configItem.value.toString()}
                            onValueChange={(val) => {
                              const newConfig = { ...config };
                              newConfig[configKey] = {
                                ...configItem,
                                value: val === "true",
                              };
                              setConfig(newConfig);
                            }}
                          >
                            <SelectTrigger id={`${configKey}-input`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="true">True</SelectItem>
                              <SelectItem value="false">False</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            id={`${configKey}-input`}
                            data-testid={`${configKey}-input`}
                            value={configItem.value}
                            onChange={(e) => {
                              const newConfig = { ...config };
                              newConfig[configKey] = {
                                ...configItem,
                                value: e.target.value,
                              };
                              setConfig(newConfig);
                            }}
                            className="font-mono"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2">
              {connectionStatus === "connected" && (
                <div className="grid grid-cols-2 gap-4">
                  <Button
                    data-testid="connect-button"
                    onClick={() => {
                      onDisconnect();
                      onConnect();
                    }}
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    {transportType === "stdio" ? "Restart" : "Reconnect"}
                  </Button>
                  <Button onClick={onDisconnect}>
                    <RefreshCwOff className="w-4 h-4 mr-2" />
                    Disconnect
                  </Button>
                </div>
              )}
              {connectionStatus !== "connected" && (
                <Button className="w-full" onClick={onConnect}>
                  <Play className="w-4 h-4 mr-2" />
                  Connect
                </Button>
              )}

              <div className="flex items-center justify-center space-x-2 mb-4">
                <div
                  className={`w-2 h-2 rounded-full ${(() => {
                    switch (connectionStatus) {
                      case "connected":
                        return "bg-green-500";
                      case "connecting":
                        return "bg-yellow-500";
                      case "error":
                        return "bg-red-500";
                      case "error-connecting-to-proxy":
                        return "bg-red-500";
                      default:
                        return "bg-gray-500";
                    }
                  })()}`}
                />
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  {(() => {
                    switch (connectionStatus) {
                      case "connected":
                        return "Connected";
                      case "connecting":
                        return "Connecting...";
                      case "error": {
                        const hasProxyToken =
                          config.MCP_PROXY_AUTH_TOKEN?.value;
                        if (!hasProxyToken) {
                          return "Connection Error - Did you add the proxy session token in Configuration?";
                        }
                        return "Connection Error - Check if your MCP server is running and proxy token is correct";
                      }
                      case "error-connecting-to-proxy":
                        return "Error Connecting to MCP Inspector Proxy - Check Console logs";
                      default:
                        return "Disconnected";
                    }
                  })()}
                </span>
              </div>

              {loggingSupported && connectionStatus === "connected" && (
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="logging-level-select"
                  >
                    Logging Level
                  </label>
                  <Select
                    value={logLevel}
                    onValueChange={(value: LoggingLevel) =>
                      sendLogLevelRequest(value)
                    }
                  >
                    <SelectTrigger id="logging-level-select">
                      <SelectValue placeholder="Select logging level" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(LoggingLevelSchema.enum).map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
      <div className="p-4 border-t">
        <div className="flex items-center justify-between">
          <Select
            value={theme}
            onValueChange={(value: string) =>
              setTheme(value as "system" | "light" | "dark")
            }
          >
            <SelectTrigger className="w-[100px]" id="theme-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center space-x-2">
            <Button variant="ghost" title="Inspector Documentation" asChild>
              <a
                href="https://modelcontextprotocol.io/docs/tools/inspector"
                target="_blank"
                rel="noopener noreferrer"
              >
                <CircleHelp className="w-4 h-4 text-foreground" />
              </a>
            </Button>
            <Button variant="ghost" title="Debugging Guide" asChild>
              <a
                href="https://modelcontextprotocol.io/docs/tools/debugging"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Bug className="w-4 h-4 text-foreground" />
              </a>
            </Button>
            <Button
              variant="ghost"
              title="Report bugs or contribute on GitHub"
              asChild
            >
              <a
                href="https://github.com/modelcontextprotocol/inspector"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="w-4 h-4 text-foreground" />
              </a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;
