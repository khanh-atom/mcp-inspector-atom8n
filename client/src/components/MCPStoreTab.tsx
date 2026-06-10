import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Store,
  Search,
  Settings,
  Download,
  Plus,
  Trash2,
  ExternalLink,
  Package,
  Loader2,
  RefreshCw,
  ExternalLink as GotoIcon,
  Play,
  ChevronDown,
  ChevronRight,
  FolderOpen,
} from "lucide-react";
import { useToast } from "../lib/hooks/useToast";
import { InspectorConfig } from "@/lib/configurationTypes";
import { getMCPProxyAddress, getMCPProxyAuthToken } from "@/utils/configUtils";
import { logInfo } from "@/utils/logUtils";

interface MCPSource {
  name: string;
  url: string;
  enabled: boolean;
}

interface MCPServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  disabled: boolean;
  autoApprove: string[];
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  source?: string;
  /** The original config key used in the MCP config file */
  _configKey?: string;
  /** Raw config object for proxy/credential servers (serverUrl/url/type based) */
  _rawConfig?: Record<string, unknown>;
}

interface MCPSourceResponse {
  mcpServers: Record<string, MCPServer>;
}

interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
  serverUrl?: string;
  url?: string;
  type?: string;
  [key: string]: unknown;
}

interface MCPStoreTabProps {
  config: InspectorConfig;
  currentServers?: Record<string, ServerConfig>;
  onServersChange?: (servers: Record<string, ServerConfig>) => void;
  onTestConnection?: (serverConfig: ServerConfig) => void;
  configFilePath?: string;
  onConfigFileUpdated?: () => void;
}

/** Last path segment for store cards (POSIX and Windows separators). */
function basenamePath(p: string): string {
  if (!p) return p;
  const normalized = p.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? (parts[parts.length - 1] ?? p) : p;
}

// n8n workflow MCP: all n8n files are managed under a single config key
const N8N_MCP_KEY = "n8n-workflow-mcp";
const N8N_MCP_ARGS_PREFIX = ["exec", "n8n-atom-cli", "mcp"];

/** All known MCP configuration file definitions. */
interface MCPConfigDef {
  name: string;
  configPath: string;
  icon: string;
  /** Substring to match against configFilePath to identify this config */
  matchKey: string;
}

const ALL_MCP_CONFIGS: MCPConfigDef[] = [
  {
    name: "Cursor",
    configPath: "~/.cursor/mcp.json",
    icon: "/cursor.svg",
    matchKey: "cursor",
  },
  {
    name: "Antigravity",
    configPath: "~/.gemini/antigravity/mcp_config.json",
    icon: "/antigravity.png",
    matchKey: "antigravity",
  },
  {
    name: "Codex",
    configPath: "~/.codex/config.toml",
    icon: "/codex.png",
    matchKey: "codex",
  },
  {
    name: "OpenCode",
    configPath: "~/.config/opencode/opencode.json",
    icon: "/opencode.svg",
    matchKey: "opencode",
  },
];

const MCPStoreTab = ({
  config,
  currentServers = {},
  onServersChange,
  onTestConnection,
  configFilePath,
  onConfigFileUpdated,
}: MCPStoreTabProps) => {
  const [sources, setSources] = useState<MCPSource[]>([
    {
      name: "Default MCP Store",
      url: "https://gist.github.com/khanh-atom/fe8161eea89fb563915492b8b2de4ef9",
      enabled: true,
    },
  ]);
  const [availableServers, setAvailableServers] = useState<MCPServer[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [installingServer, setInstallingServer] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );
  const [showSourceConfig, setShowSourceConfig] = useState(false);
  const [commandPopupServer, setCommandPopupServer] =
    useState<MCPServer | null>(null);
  // Per-source enabled toggles for config-based sources (keyed by config name)
  const [configSourcesEnabled, setConfigSourcesEnabled] = useState<
    Record<string, boolean>
  >(() => {
    const saved = localStorage.getItem("mcpStoreConfigSourcesEnabled");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        // fall through
      }
    }
    // Default: all enabled
    const defaults: Record<string, boolean> = {};
    for (const cfg of ALL_MCP_CONFIGS) {
      defaults[cfg.name] = true;
    }
    return defaults;
  });
  // Current config file source: enabled toggle
  const [currentConfigSourceEnabled, setCurrentConfigSourceEnabled] = useState(
    () => {
      const saved = localStorage.getItem("mcpStoreCurrentConfigSourceEnabled");
      return saved !== null ? JSON.parse(saved) : true;
    },
  );
  // n8n workflow source: enabled toggle
  const [n8nSourceEnabled, setN8nSourceEnabled] = useState(() => {
    const saved = localStorage.getItem("mcpStoreN8nSourceEnabled");
    console.log(
      "[MCPStore:n8n] Initializing n8nSourceEnabled from localStorage:",
      saved,
    );
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [newSource, setNewSource] = useState({
    name: "",
    url: "",
    enabled: true,
  });

  // Compute ALL config-based sources (excluding the currently active config file).
  const configBasedSources = useMemo<MCPConfigDef[]>(() => {
    if (!configFilePath) return ALL_MCP_CONFIGS;
    return ALL_MCP_CONFIGS.filter(
      (cfg) => !configFilePath.includes(cfg.matchKey),
    );
  }, [configFilePath]);

  const currentSource = useMemo<{
    name: string;
    configPath: string;
    icon: string;
  } | null>(() => {
    if (!configFilePath) return null;
    if (configFilePath.includes("cursor")) {
      return {
        name: "Cursor",
        configPath: configFilePath,
        icon: "/cursor.svg",
      };
    }
    if (configFilePath.includes("antigravity")) {
      return {
        name: "Antigravity",
        configPath: configFilePath,
        icon: "/antigravity.png",
      };
    }
    if (configFilePath.includes("codex")) {
      return {
        name: "Codex",
        configPath: configFilePath,
        icon: "/codex.png",
      };
    }
    if (configFilePath.includes("opencode")) {
      return {
        name: "OpenCode",
        configPath: configFilePath,
        icon: "/opencode.svg",
      };
    }
    return null;
  }, [configFilePath]);
  const { toast } = useToast();

  // Load sources from localStorage on component mount
  useEffect(() => {
    const savedSources = localStorage.getItem("mcpStoreSources");
    if (savedSources) {
      try {
        setSources(JSON.parse(savedSources));
      } catch (error) {
        console.error("Failed to load saved sources:", error);
      }
    }
  }, []);

  // Save sources to localStorage whenever sources change
  useEffect(() => {
    localStorage.setItem("mcpStoreSources", JSON.stringify(sources));
  }, [sources, config]);

  // Save configSourcesEnabled to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem(
      "mcpStoreConfigSourcesEnabled",
      JSON.stringify(configSourcesEnabled),
    );
  }, [configSourcesEnabled]);

  // Save currentConfigSourceEnabled to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem(
      "mcpStoreCurrentConfigSourceEnabled",
      JSON.stringify(currentConfigSourceEnabled),
    );
  }, [currentConfigSourceEnabled]);

  // Save n8nSourceEnabled to localStorage whenever it changes
  useEffect(() => {
    console.log(
      "[MCPStore:n8n] Persisting n8nSourceEnabled:",
      n8nSourceEnabled,
    );
    localStorage.setItem(
      "mcpStoreN8nSourceEnabled",
      JSON.stringify(n8nSourceEnabled),
    );
  }, [n8nSourceEnabled]);

  // Fetch MCP servers from all enabled sources
  const fetchMCPServers = useCallback(async () => {
    setIsLoading(true);
    try {
      const enabledSources = sources.filter((source) => source.enabled);
      const allServers: MCPServer[] = [];

      for (const source of enabledSources) {
        try {
          const baseUrl = getMCPProxyAddress(config);
          const proxiedUrl = `${baseUrl}/fetch-json?url=${encodeURIComponent(source.url)}`;
          const { token, header } = getMCPProxyAuthToken(config);
          const response = await fetch(proxiedUrl, {
            headers: { [header]: token ? `Bearer ${token}` : "" },
          });
          if (!response.ok) {
            throw new Error(
              `Failed to fetch from ${source.name}: ${response.statusText}`,
            );
          }

          const data: MCPSourceResponse = await response.json();
          const servers = Object.entries(data.mcpServers).map(
            ([name, config]) => ({
              ...config,
              name,
              source: source.name,
            }),
          );

          allServers.push(...servers);
        } catch (error) {
          console.error(`Error fetching from ${source.name}:`, error);
          toast({
            title: "Error",
            description: `Failed to fetch from ${source.name}: ${error instanceof Error ? error.message : String(error)}`,
            variant: "destructive",
          });
        }
      }

      // Helper: parse a config JSON response into MCPServer[] with the given source label
      const parseConfigServers = (
        configData: any,
        sourceName: string,
      ): MCPServer[] => {
        const servers = (configData.servers || configData.mcpServers) as
          | Record<string, any>
          | undefined;
        if (!servers) return [];
        const result: MCPServer[] = [];
        for (const [name, serverCfg] of Object.entries(servers) as [
          string,
          any,
        ][]) {
          // Expand n8n-workflow-mcp into individual n8n workflow items
          if (name === N8N_MCP_KEY) {
            const args: string[] = serverCfg.args || [];
            const filePaths = args.slice(N8N_MCP_ARGS_PREFIX.length);
            for (const filePath of filePaths) {
              const fileName = basenamePath(filePath).replace(/\.n8n$/, "");
              result.push({
                name: fileName,
                command: serverCfg.command || "",
                args: [...N8N_MCP_ARGS_PREFIX, filePath],
                env: serverCfg.env || {},
                disabled: serverCfg.disabled || false,
                autoApprove: serverCfg.autoApprove || [],
                description: `n8n workflow: ${fileName}`,
                source: sourceName,
              });
            }
          } else {
            // Detect proxy/credential servers (serverUrl or url key, no command)
            const isProxy =
              !serverCfg.command && (serverCfg.serverUrl || serverCfg.url);
            result.push({
              name,
              command: serverCfg.command || "",
              args: serverCfg.args || [],
              env: serverCfg.env || {},
              disabled: serverCfg.disabled || false,
              autoApprove: serverCfg.autoApprove || [],
              description:
                serverCfg.description ||
                (isProxy
                  ? `Proxy: ${serverCfg.serverUrl || serverCfg.url}`
                  : undefined),
              version: serverCfg.version,
              author: serverCfg.author,
              license: serverCfg.license,
              source: sourceName,
              _configKey: name,
              // Preserve raw config for proxy servers so install/uninstall
              // can write back the original shape (serverUrl, url, type, etc.)
              ...(isProxy ? { _rawConfig: { ...serverCfg } } : {}),
            });
          }
        }
        return result;
      };

      // Fetch servers from the current config file
      if (currentSource && currentConfigSourceEnabled && configFilePath) {
        try {
          const baseUrl = getMCPProxyAddress(config);
          const { token, header } = getMCPProxyAuthToken(config);
          const url = `${baseUrl}/mcp-config?path=${encodeURIComponent(configFilePath)}`;
          const response = await fetch(url, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              [header]: token ? `Bearer ${token}` : "",
            },
          });
          if (response.ok) {
            const data = await response.json();
            const configServers = parseConfigServers(
              data.config,
              currentSource.name,
            );
            allServers.push(...configServers);
          }
        } catch (error) {
          console.error(
            `Error fetching from current config (${currentSource.name}):`,
            error,
          );
        }
      }

      // Fetch servers from all enabled cross-config sources
      for (const cfgSource of configBasedSources) {
        if (!configSourcesEnabled[cfgSource.name]) continue;
        try {
          const baseUrl = getMCPProxyAddress(config);
          const { token, header } = getMCPProxyAuthToken(config);
          const url = `${baseUrl}/mcp-config?path=${encodeURIComponent(cfgSource.configPath)}`;
          const response = await fetch(url, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              [header]: token ? `Bearer ${token}` : "",
            },
          });
          if (response.ok) {
            const data = await response.json();
            const configServers = parseConfigServers(
              data.config,
              cfgSource.name,
            );
            allServers.push(...configServers);
          }
        } catch (error) {
          console.error(`Error fetching from ${cfgSource.name} config:`, error);
        }
      }

      // Fetch n8n workflow files from the VSCode workspace via postMessage
      if (n8nSourceEnabled) {
        console.log(
          "[MCPStore:n8n] Requesting n8n workflow files via postMessage",
        );
        try {
          const n8nServers = await new Promise<MCPServer[]>((resolve) => {
            const timeout = setTimeout(() => {
              console.log(
                "[MCPStore:n8n] Timed out waiting for n8nFileList response",
              );
              window.removeEventListener("message", handler);
              resolve([]);
            }, 1000);

            const handler = (event: MessageEvent) => {
              if (event.data && event.data.type === "n8nFileList") {
                console.log(
                  "[MCPStore:n8n] Received n8nFileList response, files:",
                  event.data.files?.length,
                  "error:",
                  event.data.error,
                );
                clearTimeout(timeout);
                window.removeEventListener("message", handler);
                const files = event.data.files || [];
                const servers: MCPServer[] = files.map((f: any) => ({
                  name: f.name,
                  command: f.command || "npx",
                  args: f.args || [],
                  env: {},
                  disabled: false,
                  autoApprove: [],
                  description: `n8n workflow: ${f.name}`,
                  source: "Workspace",
                }));
                resolve(servers);
              }
            };

            window.addEventListener("message", handler);
            // Send request to the parent (VSCode webview bridge)
            window.parent.postMessage({ type: "listN8nFiles" }, "*");
          });

          console.log(
            `[MCPStore:n8n] Got ${n8nServers.length} n8n workflow server(s)`,
          );
          allServers.push(...n8nServers);
        } catch (error) {
          console.error(
            "[MCPStore:n8n] Error requesting n8n workflow files:",
            error,
          );
        }
      } else {
        console.log("[MCPStore:n8n] Skipping n8n source (disabled)");
      }

      setAvailableServers(allServers);
    } catch (error) {
      console.error("Error fetching MCP servers:", error);
      toast({
        title: "Error",
        description: "Failed to fetch MCP servers",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [
    sources,
    toast,
    config,
    configFilePath,
    currentSource,
    currentConfigSourceEnabled,
    configBasedSources,
    configSourcesEnabled,
    n8nSourceEnabled,
  ]);

  // Load servers on component mount and when sources change
  useEffect(() => {
    fetchMCPServers();
  }, [fetchMCPServers]);

  const handleAddSource = () => {
    if (!newSource.name || !newSource.url) {
      toast({
        title: "Error",
        description: "Please provide both name and URL for the source",
        variant: "destructive",
      });
      return;
    }

    setSources((prev) => [...prev, newSource]);
    setNewSource({ name: "", url: "", enabled: true });
    setShowSourceConfig(false);
    toast({
      title: "Success",
      description: `Added source: ${newSource.name}`,
    });
  };

  const handleRemoveSource = (sourceName: string) => {
    setSources((prev) => prev.filter((source) => source.name !== sourceName));
    toast({
      title: "Success",
      description: `Removed source: ${sourceName}`,
    });
  };

  const handleToggleSource = (sourceName: string) => {
    setSources((prev) =>
      prev.map((source) =>
        source.name === sourceName
          ? { ...source, enabled: !source.enabled }
          : source,
      ),
    );
  };

  /** Detect proxy/credential-based servers (have serverUrl/url instead of command). */
  const isProxyServer = (server: MCPServer): boolean =>
    !!server._rawConfig &&
    !server.command &&
    !!(server._rawConfig.serverUrl || server._rawConfig.url);

  /** Detect n8n workflow items from any source (n8n workflows or expanded config). */
  const isN8nWorkflow = (server: MCPServer): boolean =>
    server.source === "Workspace" ||
    !!server.description?.startsWith("n8n workflow:");

  /** Extract the n8n file path from a server's args (last element after the prefix). */
  const getN8nFilePath = (server: MCPServer): string | undefined => {
    if (!isN8nWorkflow(server)) return undefined;
    const args = server.args || [];
    return args.length > 0 ? args[args.length - 1] : undefined;
  };

  /**
   * Handle clicking on an n8n workflow title.
   * First tries to open the file via VSCode postMessage (openN8nFile).
   * If VSCode is not available (no response within 2s), falls back to
   * calling the server's /open-config-file endpoint.
   */
  const handleOpenN8nFile = useCallback(
    async (server: MCPServer) => {
      const filePath = getN8nFilePath(server);
      console.log("[MCPStore:n8n:openFile] handleOpenN8nFile called", {
        serverName: server.name,
        filePath,
        source: server.source,
      });

      if (!filePath) {
        console.warn(
          "[MCPStore:n8n:openFile] No file path found for server:",
          server.name,
        );
        toast({
          title: "Cannot open file",
          description: `No file path available for ${server.name}`,
          variant: "destructive",
        });
        return;
      }

      // Attempt 1: Try VSCode postMessage
      console.log(
        "[MCPStore:n8n:openFile] Attempting to open via VSCode postMessage, filePath:",
        filePath,
      );
      const vscodeOpened = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          console.log(
            "[MCPStore:n8n:openFile] VSCode postMessage timed out after 2s, will try server fallback",
          );
          window.removeEventListener("message", handler);
          resolve(false);
        }, 2000);

        const handler = (event: MessageEvent) => {
          if (event.data && event.data.type === "openN8nFileResponse") {
            console.log(
              "[MCPStore:n8n:openFile] Received openN8nFileResponse from VSCode:",
              {
                success: event.data.success,
                error: event.data.error,
                filePath: event.data.filePath,
              },
            );
            clearTimeout(timeout);
            window.removeEventListener("message", handler);
            resolve(!!event.data.success);
          }
        };

        window.addEventListener("message", handler);
        // Send request to parent (VSCode webview bridge)
        console.log(
          "[MCPStore:n8n:openFile] Sending openN8nFile postMessage to parent",
        );
        window.parent.postMessage({ type: "openN8nFile", filePath }, "*");
      });

      if (vscodeOpened) {
        console.log(
          "[MCPStore:n8n:openFile] File opened successfully via VSCode",
        );
        return;
      }

      // Attempt 2: Fall back to server /open-config-file endpoint
      console.log(
        "[MCPStore:n8n:openFile] Falling back to server /open-config-file endpoint, filePath:",
        filePath,
      );
      try {
        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);
        const url = `${baseUrl}/open-config-file?path=${encodeURIComponent(filePath)}`;
        console.log("[MCPStore:n8n:openFile] Server fallback POST URL:", url);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
        });

        console.log(
          "[MCPStore:n8n:openFile] Server fallback response:",
          response.status,
          response.statusText,
        );

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          console.error(
            "[MCPStore:n8n:openFile] Server fallback error:",
            errData,
          );
          throw new Error(errData.message || `HTTP ${response.status}`);
        }

        console.log(
          "[MCPStore:n8n:openFile] File opened successfully via server fallback",
        );
      } catch (error) {
        console.error(
          "[MCPStore:n8n:openFile] Failed to open file via server fallback:",
          error,
        );
        toast({
          title: "Failed to open file",
          description: `Could not open ${server.name}: ${error instanceof Error ? error.message : String(error)}`,
          variant: "destructive",
        });
      }
    },
    [config, toast],
  );

  // Check if a server is already installed
  const isServerInstalled = (server: MCPServer): boolean => {
    // n8n workflows: check if the file path is in the n8n-workflow-mcp args
    if (isN8nWorkflow(server)) {
      const n8nEntry = currentServers[N8N_MCP_KEY];
      if (!n8nEntry) return false;
      const n8nArgs = Array.isArray(n8nEntry.args) ? n8nEntry.args : [];
      // The file path is the last element of this server's args
      const filePath = server.args?.[server.args.length - 1];
      const installed = filePath ? n8nArgs.includes(filePath) : false;
      console.log(
        "[MCPStore:n8n] isServerInstalled",
        server.name,
        "filePath:",
        filePath,
        "installed:",
        installed,
      );
      return installed;
    }
    // Proxy/credential servers: match by config key (exact name in config)
    if (isProxyServer(server)) {
      const configKey = server._configKey || server.name;
      const installed = configKey in currentServers;
      console.log(
        "[MCPStore:proxy] isServerInstalled",
        server.name,
        "configKey:",
        configKey,
        "installed:",
        installed,
      );
      return installed;
    }
    // Check by name: if the server name is a key in currentServers, it's installed
    if (server.name in currentServers) {
      return true;
    }
    // Also check by _configKey if available
    if (server._configKey && server._configKey in currentServers) {
      return true;
    }
    // Fall back to matching by command + args (for servers from external sources)
    return Object.values(currentServers).some(
      (existingServer: ServerConfig) => {
        // Check if command and args match
        if (
          existingServer.command &&
          existingServer.command === server.command
        ) {
          const existingArgs = Array.isArray(existingServer.args)
            ? existingServer.args
            : [];
          const serverArgs = Array.isArray(server.args) ? server.args : [];
          return JSON.stringify(existingArgs) === JSON.stringify(serverArgs);
        }
        return false;
      },
    );
  };

  const getServerKey = (server: MCPServer) =>
    `${server.name}-${server.command}`;

  const handleInstallServer = async (server: MCPServer) => {
    const serverKey = getServerKey(server);
    console.log("[MCPStore] handleInstallServer called", {
      serverKey,
      serverName: server.name,
      serverCommand: server.command,
      serverArgs: server.args,
      configFilePath,
      currentServersKeys: Object.keys(currentServers),
    });
    setInstallingServer(serverKey);
    try {
      let updatedServers: Record<string, ServerConfig>;

      // n8n workflows: add file path to the shared n8n-workflow-mcp entry
      if (isN8nWorkflow(server)) {
        const filePath = server.args?.[server.args.length - 1];
        console.log(
          "[MCPStore:n8n] Installing n8n workflow, filePath:",
          filePath,
        );
        const existingEntry = currentServers[N8N_MCP_KEY];
        const existingArgs = existingEntry
          ? Array.isArray(existingEntry.args)
            ? existingEntry.args
            : []
          : [...N8N_MCP_ARGS_PREFIX];

        // Only add if not already present
        const newArgs = existingArgs.includes(filePath)
          ? existingArgs
          : [...existingArgs, filePath];

        updatedServers = {
          ...currentServers,
          [N8N_MCP_KEY]: {
            command: "npm",
            args: newArgs,
            env: existingEntry?.env || {},
            disabled: existingEntry?.disabled || false,
            autoApprove: existingEntry?.autoApprove || [],
          },
        };
        console.log("[MCPStore:n8n] Updated n8n-workflow-mcp args:", newArgs);
      } else if (isProxyServer(server)) {
        // Proxy/credential server install — write back the original config shape
        const configKey = server._configKey || server.name;
        const rawConfig = server._rawConfig || {};
        console.log("[MCPStore:proxy] Installing proxy server", {
          configKey,
          rawConfig,
        });

        updatedServers = {
          ...currentServers,
          [configKey]: rawConfig as ServerConfig,
        };
      } else {
        // Standard server install
        // Generate the server configuration
        const serverConfig: ServerConfig = {
          command: server.command,
          args: server.args,
          env: server.env,
          disabled: server.disabled,
          autoApprove: server.autoApprove,
        };
        console.log("[MCPStore] Generated serverConfig:", serverConfig);

        // Generate a unique server name (use the store name or create one)
        const serverName = server.name
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-");
        const finalServerName = Object.keys(currentServers).includes(serverName)
          ? `${serverName}-${Date.now()}`
          : serverName;
        console.log("[MCPStore] Server name:", {
          serverName,
          finalServerName,
        });

        // Add the new server to current configuration
        updatedServers = {
          ...currentServers,
          [finalServerName]: serverConfig,
        };
      }
      console.log("[MCPStore] updatedServers:", updatedServers);

      // Update the MCP configuration file via API
      const baseUrl = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);

      // Build the URL with configFilePath as query param if available
      let updateUrl = `${baseUrl}/update-mcp-config`;
      if (configFilePath) {
        updateUrl += `?path=${encodeURIComponent(configFilePath)}`;
      }
      console.log("[MCPStore] POST URL:", updateUrl);
      console.log(
        "[MCPStore] Request body:",
        JSON.stringify({ servers: updatedServers }, null, 2),
      );

      const response = await fetch(updateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [header]: token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({ servers: updatedServers }),
      });

      console.log(
        "[MCPStore] Response status:",
        response.status,
        response.statusText,
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error("[MCPStore] Error response data:", errorData);
        throw new Error(
          errorData.message ||
            `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const responseData = await response.json();
      console.log("[MCPStore] Success response:", responseData);

      // Refresh the current servers
      if (onServersChange) {
        console.log("[MCPStore] Calling onServersChange with updated servers");
        onServersChange(updatedServers);
      } else {
        console.warn("[MCPStore] onServersChange callback is not provided!");
      }

      toast({
        title: "Server Installed",
        description: `${server.name} has been added to your MCP configuration.`,
      });

      // Notify parent to refresh sidebar config counts & server list
      if (onConfigFileUpdated) {
        console.log("[MCPStore] Calling onConfigFileUpdated");
        onConfigFileUpdated();
      }
    } catch (error) {
      console.error("[MCPStore] Install error:", error);
      toast({
        title: "Error",
        description: `Failed to install server: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
    } finally {
      setTimeout(() => setInstallingServer(null), 500);
    }
  };

  const handleTestConnection = async (server: MCPServer) => {
    const serverKey = `${server.name}-${server.command}`;
    setTestingServer(serverKey);

    try {
      const serverConfig = {
        command: server.command,
        args: server.args,
        env: server.env,
        disabled: server.disabled,
        autoApprove: server.autoApprove,
      };

      // Log the test connection attempt to the server logs
      await logInfo(
        config,
        `Testing connection to MCP server: ${server.name} (${server.command})`,
        {
          serverName: server.name,
          command: server.command,
          args: server.args,
          source: "MCPStoreTab",
        },
      );

      if (onTestConnection) {
        onTestConnection(serverConfig);
      } else {
        toast({
          title: "Test Connection",
          description: `Testing connection to ${server.name}...`,
        });
      }
    } finally {
      // Keep spinner visible briefly so the user sees feedback
      setTimeout(() => setTestingServer(null), 2000);
    }
  };

  const handleUninstallServer = async (server: MCPServer) => {
    const serverKey = getServerKey(server);
    console.log("[MCPStore] handleUninstallServer called", {
      serverKey,
      serverName: server.name,
      configFilePath,
      currentServersKeys: Object.keys(currentServers),
    });
    setInstallingServer(serverKey);
    try {
      let updatedServers: Record<string, ServerConfig>;
      let serverName: string | undefined;

      // n8n workflows: remove file path from the shared n8n-workflow-mcp entry
      if (isN8nWorkflow(server)) {
        const filePath = server.args?.[server.args.length - 1];
        console.log(
          "[MCPStore:n8n] Uninstalling n8n workflow, filePath:",
          filePath,
        );
        const existingEntry = currentServers[N8N_MCP_KEY];
        if (existingEntry) {
          serverName = N8N_MCP_KEY;
          const existingArgs = Array.isArray(existingEntry.args)
            ? existingEntry.args
            : [];
          const newArgs = existingArgs.filter((arg) => arg !== filePath);

          updatedServers = { ...currentServers };
          // If only the prefix args remain (no file paths), remove the entry
          if (newArgs.length <= N8N_MCP_ARGS_PREFIX.length) {
            console.log(
              "[MCPStore:n8n] No n8n files left, removing n8n-workflow-mcp entry",
            );
            delete updatedServers[N8N_MCP_KEY];
          } else {
            updatedServers[N8N_MCP_KEY] = {
              ...existingEntry,
              args: newArgs,
            };
          }
          console.log(
            "[MCPStore:n8n] Updated n8n-workflow-mcp args after removal:",
            newArgs,
          );
        } else {
          serverName = undefined;
          updatedServers = { ...currentServers };
        }
      } else if (isProxyServer(server)) {
        // Proxy/credential server uninstall — match by config key
        serverName = server._configKey || server.name;
        console.log(
          "[MCPStore:proxy] Uninstalling proxy server, configKey:",
          serverName,
        );
        updatedServers = { ...currentServers };
        if (serverName && serverName in updatedServers) {
          delete updatedServers[serverName];
        } else {
          serverName = undefined;
        }
      } else {
        // Standard server uninstall
        // Find the server name in current configuration — first try _configKey, then name, then command+args match
        serverName =
          (server._configKey && server._configKey in currentServers
            ? server._configKey
            : undefined) ||
          (server.name in currentServers ? server.name : undefined) ||
          Object.keys(currentServers).find((name) => {
            const existingServer = currentServers[name];
            if (
              existingServer.command &&
              existingServer.command === server.command
            ) {
              const existingArgs = Array.isArray(existingServer.args)
                ? existingServer.args
                : [];
              const serverArgs = Array.isArray(server.args) ? server.args : [];
              return (
                JSON.stringify(existingArgs) === JSON.stringify(serverArgs)
              );
            }
            return false;
          });

        // Generate configuration without this server
        updatedServers = { ...currentServers };
        if (serverName) {
          delete updatedServers[serverName];
        }
      }

      console.log("[MCPStore] Found server to uninstall:", serverName);

      if (serverName) {
        console.log(
          "[MCPStore] Updated servers after removal:",
          Object.keys(updatedServers),
        );

        // Update the MCP configuration file via API
        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);

        let updateUrl = `${baseUrl}/update-mcp-config`;
        if (configFilePath) {
          updateUrl += `?path=${encodeURIComponent(configFilePath)}`;
        }
        console.log("[MCPStore] Uninstall POST URL:", updateUrl);

        const response = await fetch(updateUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
          body: JSON.stringify({ servers: updatedServers }),
        });

        console.log(
          "[MCPStore] Uninstall response status:",
          response.status,
          response.statusText,
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error("[MCPStore] Uninstall error response:", errorData);
          throw new Error(
            errorData.message ||
              `HTTP ${response.status}: ${response.statusText}`,
          );
        }

        const responseData = await response.json();
        console.log("[MCPStore] Uninstall success response:", responseData);

        // Refresh the current servers
        if (onServersChange) {
          onServersChange(updatedServers);
        }

        toast({
          title: "Server Uninstalled",
          description: `${server.name} (${serverName}) has been removed from your MCP configuration file.`,
        });

        // Notify parent to refresh sidebar config counts & server list
        if (onConfigFileUpdated) {
          console.log("[MCPStore] Calling onConfigFileUpdated after uninstall");
          onConfigFileUpdated();
        }
      } else {
        console.warn(
          "[MCPStore] Server not found in currentServers for uninstall",
        );
        toast({
          title: "Server Not Found",
          description: `Could not find ${server.name} in current configuration.`,
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("[MCPStore] Uninstall error:", error);
      toast({
        title: "Error",
        description: `Failed to uninstall server: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
    } finally {
      setTimeout(() => setInstallingServer(null), 500);
    }
  };

  // Batch install all servers from a group in one API call
  const handleInstallAll = async (servers: MCPServer[]) => {
    const uninstalled = servers.filter((s) => !isServerInstalled(s));
    console.log(
      "[MCPStore:batch] handleInstallAll called, uninstalled count:",
      uninstalled.length,
      "server names:",
      uninstalled.map((s) => s.name),
    );
    if (uninstalled.length === 0) return;

    setInstallingServer("batch-install");
    try {
      let updatedServers = { ...currentServers };

      // Partition into n8n workflows vs standard servers
      const n8nServers = uninstalled.filter((s) => isN8nWorkflow(s));
      const standardServers = uninstalled.filter((s) => !isN8nWorkflow(s));
      console.log(
        "[MCPStore:batch] Partitioned — n8n:",
        n8nServers.length,
        "standard:",
        standardServers.length,
      );

      // Handle n8n workflows: merge file paths into the shared n8n-workflow-mcp entry
      if (n8nServers.length > 0) {
        const existingEntry = updatedServers[N8N_MCP_KEY];
        let mergedArgs = existingEntry
          ? Array.isArray(existingEntry.args)
            ? [...existingEntry.args]
            : []
          : [...N8N_MCP_ARGS_PREFIX];

        for (const server of n8nServers) {
          const filePath = server.args?.[server.args.length - 1];
          console.log(
            "[MCPStore:n8n:batch] Installing n8n workflow, filePath:",
            filePath,
          );
          if (filePath && !mergedArgs.includes(filePath)) {
            mergedArgs.push(filePath);
          }
        }

        updatedServers[N8N_MCP_KEY] = {
          command: "npm",
          args: mergedArgs,
          env: existingEntry?.env || {},
          disabled: existingEntry?.disabled || false,
          autoApprove: existingEntry?.autoApprove || [],
        };
        console.log(
          "[MCPStore:n8n:batch] Updated n8n-workflow-mcp args:",
          mergedArgs,
        );
      }

      // Handle standard and proxy servers
      for (const server of standardServers) {
        if (isProxyServer(server)) {
          // Proxy/credential server — use original config key and raw config
          const configKey = server._configKey || server.name;
          updatedServers[configKey] = (server._rawConfig as ServerConfig) || {};
          console.log(
            "[MCPStore:batch] Added proxy server:",
            configKey,
            server._rawConfig,
          );
        } else {
          const serverConfig: ServerConfig = {
            command: server.command,
            args: server.args,
            env: server.env,
            disabled: server.disabled,
            autoApprove: server.autoApprove,
          };
          const serverName = server.name
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-");
          const finalName = Object.keys(updatedServers).includes(serverName)
            ? `${serverName}-${Date.now()}`
            : serverName;
          updatedServers[finalName] = serverConfig;
          console.log(
            "[MCPStore:batch] Added standard server:",
            finalName,
            serverConfig,
          );
        }
      }

      const baseUrl = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      let updateUrl = `${baseUrl}/update-mcp-config`;
      if (configFilePath) {
        updateUrl += `?path=${encodeURIComponent(configFilePath)}`;
      }
      console.log("[MCPStore:batch] POST URL:", updateUrl);

      const response = await fetch(updateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [header]: token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({ servers: updatedServers }),
      });

      console.log(
        "[MCPStore:batch] Install response status:",
        response.status,
        response.statusText,
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error("[MCPStore:batch] Install error response:", errorData);
        throw new Error(
          errorData.message ||
            `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      if (onServersChange) onServersChange(updatedServers);
      toast({
        title: "All Servers Installed",
        description: `${uninstalled.length} server(s) have been added.`,
      });
      if (onConfigFileUpdated) onConfigFileUpdated();
    } catch (error) {
      console.error("[MCPStore:batch] Install all error:", error);
      toast({
        title: "Error",
        description: `Failed to install servers: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
    } finally {
      setTimeout(() => setInstallingServer(null), 500);
    }
  };

  // Batch uninstall all servers from a group in one API call
  const handleUninstallAll = async (servers: MCPServer[]) => {
    const installed = servers.filter((s) => isServerInstalled(s));
    console.log(
      "[MCPStore:batch] handleUninstallAll called, installed count:",
      installed.length,
      "server names:",
      installed.map((s) => s.name),
    );
    if (installed.length === 0) return;

    setInstallingServer("batch-uninstall");
    try {
      let updatedServers = { ...currentServers };

      // Partition into n8n workflows vs standard servers
      const n8nServers = installed.filter((s) => isN8nWorkflow(s));
      const standardServers = installed.filter((s) => !isN8nWorkflow(s));
      console.log(
        "[MCPStore:batch] Uninstall partitioned — n8n:",
        n8nServers.length,
        "standard:",
        standardServers.length,
      );

      // Handle n8n workflows: remove file paths from the shared n8n-workflow-mcp entry
      if (n8nServers.length > 0) {
        const existingEntry = updatedServers[N8N_MCP_KEY];
        if (existingEntry) {
          const existingArgs = Array.isArray(existingEntry.args)
            ? [...existingEntry.args]
            : [];
          const filePathsToRemove = n8nServers
            .map((s) => s.args?.[s.args.length - 1])
            .filter(Boolean);
          console.log(
            "[MCPStore:n8n:batch] File paths to remove:",
            filePathsToRemove,
          );

          const newArgs = existingArgs.filter(
            (arg) => !filePathsToRemove.includes(arg),
          );

          // If only the prefix args remain (no file paths), remove the entry
          if (newArgs.length <= N8N_MCP_ARGS_PREFIX.length) {
            console.log(
              "[MCPStore:n8n:batch] No n8n files left, removing n8n-workflow-mcp entry",
            );
            delete updatedServers[N8N_MCP_KEY];
          } else {
            updatedServers[N8N_MCP_KEY] = {
              ...existingEntry,
              args: newArgs,
            };
            console.log(
              "[MCPStore:n8n:batch] Updated n8n-workflow-mcp args after removal:",
              newArgs,
            );
          }
        } else {
          console.warn(
            "[MCPStore:n8n:batch] n8n-workflow-mcp entry not found for uninstall",
          );
        }
      }

      // Handle standard and proxy servers
      for (const server of standardServers) {
        let matchedName: string | undefined;
        if (isProxyServer(server)) {
          // Proxy servers: match by config key
          const configKey = server._configKey || server.name;
          if (configKey in updatedServers) {
            matchedName = configKey;
          }
        } else {
          matchedName =
            (server._configKey && server._configKey in updatedServers
              ? server._configKey
              : undefined) ||
            (server.name in updatedServers ? server.name : undefined) ||
            Object.keys(updatedServers).find((name) => {
              const existing = updatedServers[name];
              if (existing.command && existing.command === server.command) {
                const existingArgs = Array.isArray(existing.args)
                  ? existing.args
                  : [];
                const serverArgs = Array.isArray(server.args)
                  ? server.args
                  : [];
                return (
                  JSON.stringify(existingArgs) === JSON.stringify(serverArgs)
                );
              }
              return false;
            });
        }
        if (matchedName) {
          delete updatedServers[matchedName];
          console.log("[MCPStore:batch] Removed server:", matchedName);
        }
      }

      const baseUrl = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      let updateUrl = `${baseUrl}/update-mcp-config`;
      if (configFilePath) {
        updateUrl += `?path=${encodeURIComponent(configFilePath)}`;
      }
      console.log("[MCPStore:batch] Uninstall POST URL:", updateUrl);

      const response = await fetch(updateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [header]: token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({ servers: updatedServers }),
      });

      console.log(
        "[MCPStore:batch] Uninstall response status:",
        response.status,
        response.statusText,
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error("[MCPStore:batch] Uninstall error response:", errorData);
        throw new Error(
          errorData.message ||
            `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      if (onServersChange) onServersChange(updatedServers);
      toast({
        title: "All Servers Uninstalled",
        description: `${installed.length} server(s) have been removed.`,
      });
      if (onConfigFileUpdated) onConfigFileUpdated();
    } catch (error) {
      console.error("[MCPStore:batch] Uninstall all error:", error);
      toast({
        title: "Error",
        description: `Failed to uninstall servers: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
    } finally {
      setTimeout(() => setInstallingServer(null), 500);
    }
  };

  const filteredServers = availableServers.filter(
    (server) =>
      server.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (server.description &&
        server.description.toLowerCase().includes(searchQuery.toLowerCase())),
  );

  const urlForSourceName = (name: string | undefined) =>
    name ? sources.find((s) => s.name === name)?.url : undefined;

  // Group filtered servers by source, config-based source first
  const groupedServers = useMemo(() => {
    const groups: Record<string, MCPServer[]> = {};
    for (const server of filteredServers) {
      const sourceName = server.source || "Unknown";
      if (!groups[sourceName]) {
        groups[sourceName] = [];
      }
      groups[sourceName].push(server);
    }
    // Sort: n8n workflows first, then cross-config sources, then the rest, current config last
    const currentName = currentSource?.name;
    const configNames = new Set(configBasedSources.map((s) => s.name));
    const entries = Object.entries(groups);
    entries.sort(([a], [b]) => {
      // Current config source last
      if (currentName && a === currentName) return 1;
      if (currentName && b === currentName) return -1;
      if (a === "Workspace") return -1;
      if (b === "Workspace") return 1;
      // Config-based sources come before other non-workspace sources
      const aIsConfig = configNames.has(a);
      const bIsConfig = configNames.has(b);
      if (aIsConfig && !bIsConfig) return -1;
      if (!aIsConfig && bIsConfig) return 1;
      return 0;
    });
    return Object.fromEntries(entries);
  }, [filteredServers, currentSource, configBasedSources]);

  const toggleGroup = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  };

  return (
    <div className="w-full p-4">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Store className="w-6 h-6" />
            MCP store
            {currentSource && (
              <span className="flex items-center gap-1 font-normal text-lg">
                (
                <button
                  onClick={async () => {
                    try {
                      const baseUrl = getMCPProxyAddress(config);
                      const { token, header } = getMCPProxyAuthToken(config);
                      await fetch(
                        `${baseUrl}/open-config-file?path=${encodeURIComponent(currentSource.configPath)}`,
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
                  className="flex items-center gap-1 hover:underline hover:text-primary transition-colors cursor-pointer"
                  title="Open configuration file"
                >
                  <img
                    src={currentSource.icon}
                    alt={currentSource.name}
                    className="w-5 h-5 object-contain"
                  />
                  {currentSource.name}
                </button>
                )
              </span>
            )}
          </h1>
          <p className="text-muted-foreground">
            Discover and install MCP servers from various sources
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowSourceConfig(true)}
            className="flex items-center gap-2"
          >
            <Settings className="w-4 h-4" />
            Configure Sources
          </Button>
          <Button
            variant="outline"
            onClick={fetchMCPServers}
            disabled={isLoading}
            className="flex items-center gap-2"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Search MCP servers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Servers Grouped by Source */}
      <div className="space-y-4">
        {Object.entries(groupedServers).map(([sourceName, servers]) => {
          const isCollapsed = collapsedGroups.has(sourceName);
          const sourceUrl = urlForSourceName(sourceName);
          return (
            <div
              key={sourceName}
              className="border rounded-lg"
              style={{ containerType: "inline-size" }}
            >
              <div className="flex items-center gap-2 px-4 py-3 rounded-t-lg">
                <button
                  onClick={() => toggleGroup(sourceName)}
                  className="flex items-center gap-2 hover:bg-muted/50 rounded px-1 py-0.5 transition-colors"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-4 h-4 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 shrink-0" />
                  )}
                  <span className="font-semibold text-sm">{sourceName}</span>
                  <Badge variant="secondary" className="text-xs">
                    {servers.length}
                  </Badge>
                </button>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleInstallAll(servers)}
                    disabled={
                      servers.every((s) => isServerInstalled(s)) ||
                      installingServer !== null
                    }
                    title="Install All"
                  >
                    <Download className="w-3 h-3 shrink-0" />
                    <span className="group-header-label">Install All</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleUninstallAll(servers)}
                    disabled={
                      servers.every((s) => !isServerInstalled(s)) ||
                      installingServer !== null
                    }
                    title="Uninstall All"
                  >
                    <Trash2 className="w-3 h-3 shrink-0" />
                    <span className="group-header-label">Uninstall All</span>
                  </Button>
                  {currentSource && sourceName === currentSource.name && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={async () => {
                        try {
                          const baseUrl = getMCPProxyAddress(config);
                          const { token, header } =
                            getMCPProxyAuthToken(config);
                          await fetch(
                            `${baseUrl}/open-config-file?path=${encodeURIComponent(currentSource.configPath)}`,
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
                      <FolderOpen className="w-3 h-3 shrink-0" />
                      <span className="group-header-label">Open File</span>
                    </Button>
                  )}
                  {configBasedSources
                    .filter((cbs) => cbs.name === sourceName)
                    .map((cbs) => (
                      <Button
                        key={cbs.name}
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={async () => {
                          try {
                            const baseUrl = getMCPProxyAddress(config);
                            const { token, header } =
                              getMCPProxyAuthToken(config);
                            await fetch(
                              `${baseUrl}/open-config-file?path=${encodeURIComponent(cbs.configPath)}`,
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
                        <FolderOpen className="w-3 h-3 shrink-0" />
                        <span className="group-header-label">Open File</span>
                      </Button>
                    ))}
                  {sourceUrl && (
                    <a
                      href={sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-primary p-1"
                    >
                      <GotoIcon className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </div>
              {!isCollapsed && (
                <div className="px-4 pb-4 pt-2 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {servers.map((server, index) => (
                    <Card
                      key={`${server.name}-${index}`}
                      className="hover:shadow-md transition-shadow"
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-center gap-2">
                          {isN8nWorkflow(server) ? (
                            <img
                              src="/n8n-logo.png"
                              alt="n8n"
                              className="w-5 h-5"
                            />
                          ) : (
                            <Package className="w-5 h-5 text-primary" />
                          )}
                          {isN8nWorkflow(server) ? (
                            <CardTitle
                              className="text-lg cursor-pointer hover:text-primary hover:underline transition-colors"
                              onClick={() => {
                                console.log(
                                  "[MCPStore:n8n:openFile] Title clicked for n8n item:",
                                  server.name,
                                );
                                handleOpenN8nFile(server);
                              }}
                              title={`Open ${server.name} in editor`}
                            >
                              {server.name}
                            </CardTitle>
                          ) : (
                            <CardTitle className="text-lg">
                              {server.name}
                            </CardTitle>
                          )}
                        </div>
                        {server.description && (
                          <CardDescription className="text-sm">
                            {server.description}
                          </CardDescription>
                        )}
                      </CardHeader>
                      <CardContent className="pt-0">
                        <div className="space-y-3">
                          <div className="flex items-start gap-2 text-sm text-muted-foreground min-w-0">
                            <span className="shrink-0">Command:</span>
                            <code
                              className="bg-muted px-2 py-1 rounded text-xs min-w-0 flex-1 overflow-hidden block cursor-pointer hover:bg-muted/80 transition-colors"
                              style={{
                                display: "-webkit-box",
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical" as const,
                              }}
                              title="Click to view full command"
                              onClick={() => setCommandPopupServer(server)}
                            >
                              {basenamePath(server.command)}{" "}
                              {server.args
                                .map((a) => basenamePath(a))
                                .join(" ")}
                            </code>
                          </div>

                          {server.version && (
                            <div className="flex items-center gap-2 text-sm">
                              <span className="text-muted-foreground">
                                Version:
                              </span>
                              <span>{server.version}</span>
                            </div>
                          )}

                          {server.author && (
                            <div className="flex items-center gap-2 text-sm">
                              <span className="text-muted-foreground">
                                Author:
                              </span>
                              <span>{server.author}</span>
                            </div>
                          )}

                          {server.license && (
                            <div className="flex items-center gap-2 text-sm">
                              <span className="text-muted-foreground">
                                License:
                              </span>
                              <span>{server.license}</span>
                            </div>
                          )}

                          <div className="flex items-center gap-2">
                            {isServerInstalled(server) ? (
                              <Button
                                onClick={() => handleUninstallServer(server)}
                                className="flex-1"
                                size="sm"
                                variant="destructive"
                                disabled={
                                  installingServer === getServerKey(server)
                                }
                              >
                                {installingServer === getServerKey(server) ? (
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : (
                                  <Trash2 className="w-4 h-4 mr-2" />
                                )}
                                {installingServer === getServerKey(server)
                                  ? "Uninstalling..."
                                  : "Uninstall"}
                              </Button>
                            ) : (
                              <Button
                                onClick={() => handleInstallServer(server)}
                                className="flex-1"
                                size="sm"
                                disabled={
                                  installingServer === getServerKey(server)
                                }
                              >
                                {installingServer === getServerKey(server) ? (
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : (
                                  <Download className="w-4 h-4 mr-2" />
                                )}
                                {installingServer === getServerKey(server)
                                  ? "Installing..."
                                  : "Install"}
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleTestConnection(server)}
                              title="Test connection to this server"
                              disabled={
                                testingServer ===
                                `${server.name}-${server.command}`
                              }
                            >
                              {testingServer ===
                              `${server.name}-${server.command}` ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Play className="w-4 h-4" />
                              )}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                const cfg = isProxyServer(server)
                                  ? server._rawConfig || {}
                                  : {
                                      command: server.command,
                                      args: server.args,
                                      env: server.env,
                                      disabled: server.disabled,
                                      autoApprove: server.autoApprove,
                                    };
                                console.log("Server config:", cfg);
                              }}
                              title="View server configuration"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filteredServers.length === 0 && !isLoading && (
        <div className="text-center py-12">
          <Package className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">No servers found</h3>
          <p className="text-muted-foreground">
            {searchQuery
              ? "Try adjusting your search terms"
              : "No MCP servers available from configured sources"}
          </p>
        </div>
      )}

      {/* Source Configuration Dialog */}
      <Dialog open={showSourceConfig} onOpenChange={setShowSourceConfig}>
        <DialogContent className="max-w-4xl w-full max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Configure MCP Sources</DialogTitle>
            <DialogDescription>
              Add and manage sources for MCP servers. Sources should provide
              JSON files with mcpServers configuration.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto flex-1 pr-1">
            {/* Existing Sources */}
            <div>
              <Label className="text-sm font-medium mb-2 block">
                Current Sources
              </Label>
              <div className="space-y-2">
                {sources.map((source, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-3 p-4 border rounded-lg"
                  >
                    <div className="flex-shrink-0 pt-1">
                      <Switch
                        checked={source.enabled}
                        onCheckedChange={() => handleToggleSource(source.name)}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium mb-1">
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-1"
                        >
                          {source.name}
                          <GotoIcon
                            className="w-3.5 h-3.5 shrink-0 opacity-80"
                            aria-hidden
                          />
                        </a>
                      </div>
                      <div className="text-sm text-muted-foreground break-all">
                        {source.url}
                      </div>
                    </div>
                    <div className="flex-shrink-0 flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRemoveSource(source.name)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Current Config File Source (read-only) */}
            {currentSource && (
              <div>
                <Label className="text-sm font-medium mb-2 block">
                  Current Config File
                </Label>
                <div className="space-y-2">
                  <div className="flex items-start gap-3 p-4 border rounded-lg bg-muted/30">
                    <div className="flex-shrink-0 pt-1">
                      <Switch
                        checked={currentConfigSourceEnabled}
                        onCheckedChange={setCurrentConfigSourceEnabled}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <button
                        className="font-medium mb-1 inline-flex items-center gap-1.5 text-primary hover:underline cursor-pointer"
                        onClick={async () => {
                          try {
                            const baseUrl = getMCPProxyAddress(config);
                            const { token, header } =
                              getMCPProxyAuthToken(config);
                            await fetch(
                              `${baseUrl}/open-config-file?path=${encodeURIComponent(currentSource.configPath)}`,
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
                        <img
                          src={currentSource.icon}
                          alt={currentSource.name}
                          className="w-4 h-4"
                        />
                        {currentSource.name}
                        <GotoIcon
                          className="w-3.5 h-3.5 shrink-0 opacity-80"
                          aria-hidden
                        />
                      </button>
                      <div className="text-sm text-muted-foreground break-all">
                        {currentSource.configPath}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Servers from the currently active config file
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Config-based Sources (all known MCP files except current) */}
            {configBasedSources.length > 0 && (
              <div>
                <Label className="text-sm font-medium mb-2 block">
                  MCP JSON File Sources
                </Label>
                <div className="space-y-2">
                  {configBasedSources.map((cfgSrc) => (
                    <div
                      key={cfgSrc.name}
                      className="flex items-start gap-3 p-4 border rounded-lg bg-muted/30"
                    >
                      <div className="flex-shrink-0 pt-1">
                        <Switch
                          checked={configSourcesEnabled[cfgSrc.name] ?? true}
                          onCheckedChange={(checked) =>
                            setConfigSourcesEnabled((prev) => ({
                              ...prev,
                              [cfgSrc.name]: checked,
                            }))
                          }
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <button
                          className="font-medium mb-1 inline-flex items-center gap-1.5 text-primary hover:underline cursor-pointer"
                          onClick={async () => {
                            try {
                              const baseUrl = getMCPProxyAddress(config);
                              const { token, header } =
                                getMCPProxyAuthToken(config);
                              await fetch(
                                `${baseUrl}/open-config-file?path=${encodeURIComponent(cfgSrc.configPath)}`,
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
                          <img
                            src={cfgSrc.icon}
                            alt={cfgSrc.name}
                            className="w-4 h-4"
                          />
                          {cfgSrc.name}
                          <GotoIcon
                            className="w-3.5 h-3.5 shrink-0 opacity-80"
                            aria-hidden
                          />
                        </button>
                        <div className="text-sm text-muted-foreground break-all">
                          {cfgSrc.configPath}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* n8n Workflows Source */}
            <div>
              <Label className="text-sm font-medium mb-2 block">
                n8n Workflows Source
              </Label>
              <div className="space-y-2">
                <div className="flex items-start gap-3 p-4 border rounded-lg bg-muted/30">
                  <div className="flex-shrink-0 pt-1">
                    <Switch
                      checked={n8nSourceEnabled}
                      onCheckedChange={(checked) => {
                        console.log(
                          "[MCPStore:n8n] Toggle n8n source:",
                          checked,
                        );
                        setN8nSourceEnabled(checked);
                      }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium mb-1 inline-flex items-center gap-1.5">
                      Workspace
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Lists all .n8n workflow files in the current VSCode
                      workspace
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Add New Source */}
            <div className="border-t pt-4">
              <Label className="text-sm font-medium mb-2 block">
                Add New Source
              </Label>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="source-name">Name</Label>
                  <Input
                    id="source-name"
                    placeholder="e.g., My MCP Store"
                    value={newSource.name}
                    onChange={(e) =>
                      setNewSource((prev) => ({
                        ...prev,
                        name: e.target.value,
                      }))
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="source-url">URL</Label>
                  <Input
                    id="source-url"
                    placeholder="https://example.com/mcp-servers.json"
                    value={newSource.url}
                    onChange={(e) =>
                      setNewSource((prev) => ({ ...prev, url: e.target.value }))
                    }
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={newSource.enabled}
                    onCheckedChange={(checked) =>
                      setNewSource((prev) => ({ ...prev, enabled: checked }))
                    }
                    id="source-enabled"
                  />
                  <Label htmlFor="source-enabled">Enabled</Label>
                </div>
                <Button onClick={handleAddSource} className="w-full">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Source
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Command detail popup */}
      <Dialog
        open={!!commandPopupServer}
        onOpenChange={(open) => {
          if (!open) setCommandPopupServer(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5" />
              {commandPopupServer?.name} — Command
            </DialogTitle>
            <DialogDescription>Full command and arguments</DialogDescription>
          </DialogHeader>
          {commandPopupServer && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">Command</Label>
                <code className="block bg-muted px-3 py-2 rounded text-sm mt-1 break-all">
                  {commandPopupServer.command}
                </code>
              </div>
              {commandPopupServer.args.length > 0 && (
                <div>
                  <Label className="text-xs text-muted-foreground">
                    Arguments
                  </Label>
                  <div className="bg-muted px-3 py-2 rounded mt-1 space-y-1">
                    {commandPopupServer.args.map((arg, i) => (
                      <code key={i} className="block text-sm break-all">
                        {arg}
                      </code>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default MCPStoreTab;
