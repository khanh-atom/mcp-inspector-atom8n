import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Shield,
  Upload,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  FolderOpen,
  Server,
  Globe,
  FileText,
  Copy,
  Info,
  Zap,
  Pencil,
  Download,
  Trash2,
  Network,
  Search,
  CheckSquare,
  Square,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "../lib/hooks/useToast";
import { InspectorConfig } from "@/lib/configurationTypes";
import { getMCPProxyAddress, getMCPProxyAuthToken } from "@/utils/configUtils";

/** Shape of a single credential entry as returned by GET /credentials */
interface CredentialEntry {
  id?: string;
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
}

/** Raw credential data from the file */
interface RawCredentials {
  [key: string]: {
    server_name: string;
    server_url: string;
    client_id: string;
    access_token: string;
    expires_at: number;
    refresh_token: string;
    scopes: string[];
    _sourceFile?: string;
    _credentialKey?: string;
  };
}

interface CredentialTestServerConfig {
  type: "streamable-http";
  url: string;
  bearerToken?: string;
}

/** [PROXY] Tool info returned from the credential-server-tools endpoint */
interface ProxyToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface CredentialsTabProps {
  config: InspectorConfig;
  credentialsFolderPath: string;
  setCredentialsFolderPath: (path: string) => void;
  enabledCredentials: Set<string>;
  setEnabledCredentials: (keys: Set<string>) => void;
  rawCredentials: RawCredentials | null;
  setRawCredentials: (creds: RawCredentials | null) => void;
  onTestConnection?: (
    serverConfig: CredentialTestServerConfig,
  ) => void | Promise<void>;
  /** [PROXY] Current MCP servers from config file */
  currentServers?: Record<string, any>;
  /** [PROXY] Callback to update servers state */
  onServersChange?: (servers: Record<string, any>) => void;
  /** [PROXY] Path to the active MCP config file */
  configFilePath?: string;
  /** [PROXY] Callback when config file is updated */
  onConfigFileUpdated?: () => void;
}

/** Format milliseconds as a human-readable duration */
function formatDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  const seconds = Math.floor(ms / 1000);
  return `${seconds}s`;
}

const CREDENTIAL_ID_PREFIX = "credential:";

const createCredentialIdentity = (sourceFile: string, credentialKey: string) =>
  `${CREDENTIAL_ID_PREFIX}${encodeURIComponent(sourceFile)}:${encodeURIComponent(credentialKey)}`;

const getCredentialIdentity = (
  entry: Pick<CredentialEntry, "id" | "sourceFile" | "key">,
) => entry.id || createCredentialIdentity(entry.sourceFile, entry.key);

const getCredentialRecord = (
  rawCredentials: RawCredentials | null,
  entry: Pick<CredentialEntry, "id" | "sourceFile" | "key">,
) =>
  rawCredentials?.[getCredentialIdentity(entry)] || rawCredentials?.[entry.key];

const areStringSetsEqual = (left: Set<string>, right: Set<string>) =>
  left.size === right.size && [...left].every((value) => right.has(value));

const normalizeEnabledCredentialsForEntries = (
  enabledCredentials: Set<string>,
  entries: CredentialEntry[],
) => {
  const normalized = new Set<string>();

  for (const enabledKey of enabledCredentials) {
    const matchingEntries = entries.filter(
      (entry) =>
        enabledKey === getCredentialIdentity(entry) || enabledKey === entry.key,
    );

    if (matchingEntries.length === 0) {
      normalized.add(enabledKey);
      continue;
    }

    for (const entry of matchingEntries) {
      normalized.add(getCredentialIdentity(entry));
    }
  }

  return normalized;
};

const CredentialsTab = ({
  config,
  credentialsFolderPath,
  setCredentialsFolderPath,
  enabledCredentials,
  setEnabledCredentials,
  rawCredentials,
  setRawCredentials,
  onTestConnection,
  currentServers = {},
  onServersChange,
  configFilePath,
  onConfigFileUpdated,
}: CredentialsTabProps) => {
  const [entries, setEntries] = useState<CredentialEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<CredentialEntry | null>(
    null,
  );
  const [credentialNameDraft, setCredentialNameDraft] = useState("");
  const [isSavingCredentialName, setIsSavingCredentialName] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const { toast } = useToast();

  // [PROXY] State for proxy popup and install/uninstall
  const [proxyEntry, setProxyEntry] = useState<CredentialEntry | null>(null);
  const [proxyTools, setProxyTools] = useState<ProxyToolInfo[]>([]);
  const [proxyToolsLoading, setProxyToolsLoading] = useState(false);
  const [proxySelectedTools, setProxySelectedTools] = useState<Set<string>>(
    new Set(),
  );
  const [proxySearchQuery, setProxySearchQuery] = useState("");
  const [installingCredentialId, setInstallingCredentialId] = useState<
    string | null
  >(null);

  // [CREDENTIALS] Log component render state
  console.log("[CredentialsTab] Render", {
    credentialsFolderPath,
    entriesCount: entries.length,
    enabledCount: enabledCredentials.size,
    hasRawCredentials: !!rawCredentials,
  });

  // Load credentials from folder (reads all .json files)
  const loadCredentials = useCallback(
    async (folderPath?: string) => {
      const pathToLoad = folderPath || credentialsFolderPath;
      if (!pathToLoad) {
        console.log(
          "[CredentialsTab] No credentials folder path, skipping load",
        );
        return;
      }

      setIsLoading(true);
      console.log(
        `[CredentialsTab] Loading credentials from folder: ${pathToLoad}`,
      );

      try {
        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);
        const url = `${baseUrl}/credentials?path=${encodeURIComponent(pathToLoad)}`;

        console.log(`[CredentialsTab] Fetching: ${url}`);
        const resp = await fetch(url, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          console.error("[CredentialsTab] Failed to load credentials:", err);
          toast({
            title: "Error",
            description: `Failed to load credentials: ${err.message || resp.statusText}`,
            variant: "destructive",
          });
          return;
        }

        const data = await resp.json();
        console.log(
          `[CredentialsTab] Loaded ${data.count} credential(s) from ${data.files?.length || 0} file(s)`,
          data.entries?.map(
            (e: CredentialEntry) => `${e.serverName} (${e.sourceFile})`,
          ),
        );

        const loadedEntries = (data.entries || []) as CredentialEntry[];
        setEntries(loadedEntries);
        setRawCredentials(data.credentials || null);

        // Auto-enable all credentials on first load if none are enabled
        if (enabledCredentials.size === 0 && loadedEntries.length > 0) {
          const allKeys = new Set<string>(
            loadedEntries.map((entry) => getCredentialIdentity(entry)),
          );
          console.log("[CredentialsTab] Auto-enabling all credentials:", [
            ...allKeys,
          ]);
          setEnabledCredentials(allKeys);
          localStorage.setItem(
            "enabledCredentials",
            JSON.stringify([...allKeys]),
          );
        } else if (loadedEntries.length > 0) {
          const normalizedEnabled = normalizeEnabledCredentialsForEntries(
            enabledCredentials,
            loadedEntries,
          );
          if (!areStringSetsEqual(enabledCredentials, normalizedEnabled)) {
            console.log(
              "[CredentialsTab] Migrating enabled credential keys to file-aware ids:",
              [...normalizedEnabled],
            );
            setEnabledCredentials(normalizedEnabled);
            localStorage.setItem(
              "enabledCredentials",
              JSON.stringify([...normalizedEnabled]),
            );
          }
        }
      } catch (error) {
        console.error("[CredentialsTab] Error loading credentials:", error);
        toast({
          title: "Error",
          description: `Failed to load credentials: ${error instanceof Error ? error.message : String(error)}`,
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    },
    [
      config,
      credentialsFolderPath,
      enabledCredentials,
      setEnabledCredentials,
      setRawCredentials,
      toast,
    ],
  );

  // Load credentials on mount if path exists
  useEffect(() => {
    if (credentialsFolderPath) {
      console.log(
        "[CredentialsTab] Auto-loading credentials on mount/path change",
      );
      loadCredentials();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialsFolderPath]);

  // Handle choosing a folder via native picker
  const handleChooseFolder = useCallback(async () => {
    console.log("[CredentialsTab] Opening folder picker");
    try {
      const baseUrl = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      const resp = await fetch(`${baseUrl}/credentials/choose-folder`, {
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
            "[CredentialsTab] Folder chosen:",
            data.path,
            data.absolutePath,
          );
          setCredentialsFolderPath(data.path);
          localStorage.setItem("credentialsFolderPath", data.path);
          loadCredentials(data.path);
        } else {
          console.log("[CredentialsTab] Folder picker cancelled");
        }
      }
    } catch (err) {
      console.error("[CredentialsTab] Error choosing folder:", err);
      toast({
        title: "Error",
        description: "Failed to open folder picker",
        variant: "destructive",
      });
    }
  }, [config, setCredentialsFolderPath, loadCredentials, toast]);

  // [DRAG-DROP] Handle file drop — read content and upload to server into the selected folder
  const handleFileDrop = useCallback(
    async (file: File) => {
      console.log(
        `[CredentialsTab:dragDrop] File dropped: ${file.name}, size=${file.size}, type=${file.type}`,
      );

      if (!file.name.endsWith(".json")) {
        console.warn(
          "[CredentialsTab:dragDrop] Rejected non-JSON file:",
          file.name,
        );
        toast({
          title: "Invalid File",
          description: "Please drop a .json credentials file",
          variant: "destructive",
        });
        return;
      }

      setIsLoading(true);

      try {
        const content = await file.text();
        console.log(
          `[CredentialsTab:dragDrop] Read file content, length=${content.length}`,
        );

        // Validate JSON locally first
        try {
          JSON.parse(content);
        } catch {
          console.error(
            "[CredentialsTab:dragDrop] Dropped file is not valid JSON",
          );
          toast({
            title: "Invalid JSON",
            description: "The dropped file does not contain valid JSON",
            variant: "destructive",
          });
          return;
        }

        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);
        const resp = await fetch(`${baseUrl}/credentials/upload`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
          body: JSON.stringify({
            content,
            fileName: file.name,
            folderPath: credentialsFolderPath || undefined,
          }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          console.error("[CredentialsTab:dragDrop] Upload failed:", err);
          toast({
            title: "Upload Failed",
            description: err.message || `Upload failed (${resp.status})`,
            variant: "destructive",
          });
          return;
        }

        const data = await resp.json();
        console.log(
          `[CredentialsTab:dragDrop] Upload success: folder=${data.folderPath}, file=${data.fileName}, count=${data.count}`,
        );

        // Update folder path if not set yet
        if (!credentialsFolderPath && data.folderPath) {
          setCredentialsFolderPath(data.folderPath);
          localStorage.setItem("credentialsFolderPath", data.folderPath);
        }

        // Reload all credentials from the folder
        loadCredentials(data.folderPath || credentialsFolderPath);

        toast({
          title: "Credentials Loaded",
          description: `Saved ${file.name} with ${data.count} credential(s) to folder`,
        });
      } catch (error) {
        console.error("[CredentialsTab:dragDrop] Error:", error);
        toast({
          title: "Error",
          description: `Failed to process dropped file: ${error instanceof Error ? error.message : String(error)}`,
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    },
    [
      config,
      credentialsFolderPath,
      setCredentialsFolderPath,
      loadCredentials,
      toast,
    ],
  );

  // [DRAG-DROP] Window-level event listeners to prevent browser default file-open
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current += 1;
      console.log(
        `[CredentialsTab:dragDrop] window dragEnter, counter=${dragCounterRef.current}`,
      );
      if (e.dataTransfer?.types.includes("Files")) {
        setIsDragOver(true);
      }
    };

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current -= 1;
      console.log(
        `[CredentialsTab:dragDrop] window dragLeave, counter=${dragCounterRef.current}`,
      );
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDragOver(false);
      }
    };

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);

      const files = e.dataTransfer?.files;
      console.log(
        `[CredentialsTab:dragDrop] window drop event, files=${files?.length ?? 0}`,
      );

      if (files && files.length > 0) {
        handleFileDrop(files[0]);
      }
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);

    console.log(
      "[CredentialsTab:dragDrop] Window drag-drop listeners registered",
    );

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      console.log(
        "[CredentialsTab:dragDrop] Window drag-drop listeners removed",
      );
    };
  }, [handleFileDrop]);

  // Toggle a credential on/off
  const handleToggleCredential = useCallback(
    (entry: CredentialEntry) => {
      const credentialId = getCredentialIdentity(entry);
      const newEnabled = normalizeEnabledCredentialsForEntries(
        enabledCredentials,
        entries,
      );
      if (newEnabled.has(credentialId)) {
        console.log(`[CredentialsTab] Disabling credential: ${credentialId}`);
        newEnabled.delete(credentialId);
      } else {
        console.log(`[CredentialsTab] Enabling credential: ${credentialId}`);
        newEnabled.add(credentialId);
      }
      setEnabledCredentials(newEnabled);
      localStorage.setItem(
        "enabledCredentials",
        JSON.stringify([...newEnabled]),
      );
      const persistEnabledState = async () => {
        try {
          const baseUrl = getMCPProxyAddress(config);
          const { token, header } = getMCPProxyAuthToken(config);
          const resp = await fetch(`${baseUrl}/credentials/enabled`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              [header]: token ? `Bearer ${token}` : "",
            },
            body: JSON.stringify({
              folderPath: credentialsFolderPath || "./data",
              enabledCredentialKeys: [...newEnabled],
            }),
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            console.warn(
              "[CredentialsTab] Failed to persist enabled credential state:",
              err,
            );
          }
        } catch (error) {
          console.warn(
            "[CredentialsTab] Error persisting enabled credential state:",
            error,
          );
        }
      };
      void persistEnabledState();
    },
    [
      config,
      credentialsFolderPath,
      enabledCredentials,
      entries,
      setEnabledCredentials,
    ],
  );

  // Refresh a credential's token
  const handleRefreshToken = useCallback(
    async (entry: CredentialEntry) => {
      if (!credentialsFolderPath) return;

      const credentialId = getCredentialIdentity(entry);
      console.log(
        `[CredentialsTab] Refreshing token for: ${entry.key} in file: ${entry.sourceFile}`,
      );
      setRefreshingKey(credentialId);

      try {
        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);
        const resp = await fetch(`${baseUrl}/credentials/refresh`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
          body: JSON.stringify({
            folderPath: credentialsFolderPath,
            sourceFile: entry.sourceFile,
            credentialKey: entry.key,
          }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          console.error("[CredentialsTab] Token refresh failed:", err);
          toast({
            title: "Token Refresh Failed",
            description:
              err.message || `Failed to refresh token (${resp.status})`,
            variant: "destructive",
          });
          return;
        }

        const data = await resp.json();
        console.log(`[CredentialsTab] Token refreshed successfully:`, data);

        toast({
          title: "Token Refreshed",
          description: `Token for ${entry.serverName} refreshed. Expires in ${formatDuration(data.expiresInMs)}`,
        });

        // Reload credentials to get updated data
        loadCredentials();
      } catch (error) {
        console.error("[CredentialsTab] Error refreshing token:", error);
        toast({
          title: "Error",
          description: `Failed to refresh token: ${error instanceof Error ? error.message : String(error)}`,
          variant: "destructive",
        });
      } finally {
        setRefreshingKey(null);
      }
    },
    [config, credentialsFolderPath, loadCredentials, toast],
  );

  // Test connection to a server — auto-refreshes expired tokens, then delegates to App
  const handleTestConnection = useCallback(
    async (entry: CredentialEntry) => {
      if (!entry.serverUrl) {
        toast({
          title: "Cannot Test",
          description: "Missing server URL",
          variant: "destructive",
        });
        return;
      }

      console.log(`[CredentialsTab] Testing connection to: ${entry.serverUrl}`);

      let accessToken = getCredentialRecord(
        rawCredentials,
        entry,
      )?.access_token;

      // Check if token is expired and auto-refresh if possible
      if (
        entry.isExpired ||
        (entry.expiresAt && entry.expiresAt <= Date.now())
      ) {
        console.log(
          `[CredentialsTab] Token expired for ${entry.serverName}, attempting refresh...`,
        );

        if (!entry.hasRefreshToken) {
          toast({
            title: "Token Expired",
            description: `Token for ${entry.serverName} is expired and no refresh token is available`,
            variant: "destructive",
          });
          return;
        }

        if (!credentialsFolderPath) {
          toast({
            title: "Cannot Refresh",
            description: "No credentials folder set",
            variant: "destructive",
          });
          return;
        }

        toast({
          title: "Refreshing Token",
          description: `Token for ${entry.serverName} is expired. Refreshing...`,
        });

        try {
          const baseUrl = getMCPProxyAddress(config);
          const { token, header } = getMCPProxyAuthToken(config);
          const resp = await fetch(`${baseUrl}/credentials/refresh`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [header]: token ? `Bearer ${token}` : "",
            },
            body: JSON.stringify({
              folderPath: credentialsFolderPath,
              sourceFile: entry.sourceFile,
              credentialKey: entry.key,
            }),
          });

          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            console.error("[CredentialsTab] Auto-refresh failed:", err);
            toast({
              title: "Refresh Failed",
              description:
                err.message || `Failed to refresh token (${resp.status})`,
              variant: "destructive",
            });
            return;
          }

          const refreshData = await resp.json();
          console.log(
            `[CredentialsTab] Token refreshed, new expiry in ${formatDuration(refreshData.expiresInMs)}`,
          );

          // Use the new access token
          accessToken = refreshData.accessToken;

          // Reload credentials in background to update UI
          loadCredentials();

          toast({
            title: "Token Refreshed",
            description: `Token refreshed. Now connecting to ${entry.serverName}...`,
          });
        } catch (error) {
          console.error("[CredentialsTab] Auto-refresh error:", error);
          toast({
            title: "Refresh Error",
            description: `Failed to refresh token: ${error instanceof Error ? error.message : String(error)}`,
            variant: "destructive",
          });
          return;
        }
      }

      if (onTestConnection) {
        onTestConnection({
          type: "streamable-http",
          url: entry.serverUrl,
          bearerToken: accessToken || undefined,
        });
      } else {
        toast({
          title: "Test Connection",
          description: `Would connect to ${entry.serverName} at ${entry.serverUrl}`,
        });
      }
    },
    [
      onTestConnection,
      rawCredentials,
      config,
      credentialsFolderPath,
      loadCredentials,
      toast,
    ],
  );

  const closeCredentialNameDialog = useCallback(() => {
    setEditingEntry(null);
    setCredentialNameDraft("");
  }, []);

  const handleOpenCredentialNameDialog = useCallback(
    (entry: CredentialEntry) => {
      setEditingEntry(entry);
      setCredentialNameDraft(entry.serverName);
    },
    [],
  );

  const handleCredentialNameDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isSavingCredentialName) {
        closeCredentialNameDialog();
      }
    },
    [closeCredentialNameDialog, isSavingCredentialName],
  );

  const handleSaveCredentialName = useCallback(async () => {
    if (!editingEntry || !credentialsFolderPath) return;

    const nextServerName = credentialNameDraft.trim();
    if (!nextServerName) {
      toast({
        title: "Name Required",
        description: "Credential name cannot be empty",
        variant: "destructive",
      });
      return;
    }

    if (nextServerName === editingEntry.serverName) {
      closeCredentialNameDialog();
      return;
    }

    setIsSavingCredentialName(true);
    try {
      const baseUrl = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      const resp = await fetch(`${baseUrl}/credentials/name`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          [header]: token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({
          folderPath: credentialsFolderPath,
          sourceFile: editingEntry.sourceFile,
          credentialKey: editingEntry.key,
          serverName: nextServerName,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.error("[CredentialsTab] Credential rename failed:", err);
        toast({
          title: "Rename Failed",
          description:
            err.message || `Failed to rename credential (${resp.status})`,
          variant: "destructive",
        });
        return;
      }

      setEntries((currentEntries) =>
        currentEntries.map((entry) =>
          entry.key === editingEntry.key &&
          entry.sourceFile === editingEntry.sourceFile
            ? { ...entry, serverName: nextServerName }
            : entry,
        ),
      );
      const editingCredentialId = getCredentialIdentity(editingEntry);
      const editingCredential = getCredentialRecord(
        rawCredentials,
        editingEntry,
      );
      if (rawCredentials && editingCredential) {
        const nextRawCredentials = {
          ...rawCredentials,
          [editingCredentialId]: {
            ...editingCredential,
            server_name: nextServerName,
          },
        };
        if (
          rawCredentials[editingEntry.key]?._sourceFile ===
          editingEntry.sourceFile
        ) {
          nextRawCredentials[editingEntry.key] = {
            ...rawCredentials[editingEntry.key],
            server_name: nextServerName,
          };
        }
        setRawCredentials(nextRawCredentials);
      }

      toast({
        title: "Credential Renamed",
        description: `Updated name to ${nextServerName}`,
      });
      closeCredentialNameDialog();
    } catch (error) {
      console.error("[CredentialsTab] Error renaming credential:", error);
      toast({
        title: "Error",
        description: `Failed to rename credential: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
    } finally {
      setIsSavingCredentialName(false);
    }
  }, [
    closeCredentialNameDialog,
    config,
    credentialNameDraft,
    credentialsFolderPath,
    editingEntry,
    rawCredentials,
    setRawCredentials,
    toast,
  ]);

  // ── [PROXY] Helper: derive a config key from a credential entry ──────────
  const getProxyServerKey = useCallback((entry: CredentialEntry) => {
    const name = entry.serverName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return `${name}-proxy`;
  }, []);

  // [PROXY] Check if a credential's proxy server is installed in config
  const isCredentialInstalled = useCallback(
    (entry: CredentialEntry): boolean => {
      const proxyKey = getProxyServerKey(entry);
      const installed = proxyKey in currentServers;
      console.log(
        `[CredentialsTab:proxy] isCredentialInstalled: ${proxyKey} = ${installed}`,
      );
      return installed;
    },
    [currentServers, getProxyServerKey],
  );

  // [PROXY] Install a proxy MCP server entry for this credential into config
  const handleInstallCredential = useCallback(
    async (entry: CredentialEntry) => {
      const credentialId = getCredentialIdentity(entry);
      console.log(
        `[CredentialsTab:proxy] Installing proxy server for credential: ${entry.serverName}`,
        { credentialId, serverUrl: entry.serverUrl },
      );
      setInstallingCredentialId(credentialId);

      try {
        const proxyKey = getProxyServerKey(entry);
        // [PROXY] Point to the LOCAL proxy server at port 6277, NOT the remote server directly.
        // Include credential identity so the proxy can load the exact credential (no search needed).
        const proxyBaseUrl = getMCPProxyAddress(config);
        const proxyParams = new URLSearchParams({
          url: entry.serverUrl,
          transportType: "streamable-http",
          credentialFile: entry.sourceFile,
          credentialKey: entry.key,
        });

        // [PROXY] Include allowed tools in proxy URL if a selection is persisted
        try {
          const { token: authToken, header: authHeader } =
            getMCPProxyAuthToken(config);
          const credentialId = getCredentialIdentity(entry);
          const selResp = await fetch(
            `${proxyBaseUrl}/proxy/tool-selection?credentialId=${encodeURIComponent(credentialId)}&folderPath=${encodeURIComponent(credentialsFolderPath || "./data")}`,
            {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                [authHeader]: authToken ? `Bearer ${authToken}` : "",
              },
            },
          );
          if (selResp.ok) {
            const selData = await selResp.json();
            if (
              Array.isArray(selData.selectedTools) &&
              selData.selectedTools.length > 0
            ) {
              proxyParams.set("allowedTools", selData.selectedTools.join(","));
              console.log(
                `[CredentialsTab:proxy] Including ${selData.selectedTools.length} allowed tools in proxy URL`,
              );
            }
          }
        } catch (selErr) {
          console.warn(
            "[CredentialsTab:proxy] Could not load tool selection for install:",
            selErr,
          );
        }

        const proxyUrl = `${proxyBaseUrl}/mcp?${proxyParams.toString()}`;
        // [PROXY] Antigravity/Gemini CLI uses "serverUrl" key; others (Cursor) use "url"
        const isAntigravity =
          configFilePath?.includes("antigravity") ||
          configFilePath?.includes("gemini");
        const urlKey = isAntigravity ? "serverUrl" : "url";
        const proxyServerConfig = {
          [urlKey]: proxyUrl,
          type: "streamable-http",
          disabled: false,
        };

        const updatedServers = {
          ...currentServers,
          [proxyKey]: proxyServerConfig,
        };

        console.log(
          `[CredentialsTab:proxy] Adding server '${proxyKey}' to config`,
          proxyServerConfig,
        );

        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);

        let updateUrl = `${baseUrl}/update-mcp-config`;
        if (configFilePath) {
          updateUrl += `?path=${encodeURIComponent(configFilePath)}`;
        }

        console.log(`[CredentialsTab:proxy] POST ${updateUrl}`);
        const response = await fetch(updateUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
          body: JSON.stringify({ servers: updatedServers }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error("[CredentialsTab:proxy] Install failed:", errorData);
          throw new Error(
            errorData.message ||
              `HTTP ${response.status}: ${response.statusText}`,
          );
        }

        console.log(`[CredentialsTab:proxy] Install success for '${proxyKey}'`);

        if (onServersChange) {
          onServersChange(updatedServers);
        }

        toast({
          title: "Proxy Server Installed",
          description: `${entry.serverName} proxy has been added to your MCP configuration.`,
        });

        if (onConfigFileUpdated) {
          onConfigFileUpdated();
        }
      } catch (error) {
        console.error("[CredentialsTab:proxy] Install error:", error);
        toast({
          title: "Install Failed",
          description: `Failed to install proxy: ${error instanceof Error ? error.message : String(error)}`,
          variant: "destructive",
        });
      } finally {
        setTimeout(() => setInstallingCredentialId(null), 500);
      }
    },
    [
      config,
      configFilePath,
      credentialsFolderPath,
      currentServers,
      getProxyServerKey,
      onConfigFileUpdated,
      onServersChange,
      toast,
    ],
  );

  // [PROXY] Uninstall the proxy MCP server entry for this credential from config
  const handleUninstallCredential = useCallback(
    async (entry: CredentialEntry) => {
      const credentialId = getCredentialIdentity(entry);
      const proxyKey = getProxyServerKey(entry);
      console.log(
        `[CredentialsTab:proxy] Uninstalling proxy server '${proxyKey}' for credential: ${entry.serverName}`,
      );
      setInstallingCredentialId(credentialId);

      try {
        const updatedServers = { ...currentServers };
        delete updatedServers[proxyKey];

        console.log(
          `[CredentialsTab:proxy] Removing server '${proxyKey}' from config`,
        );

        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);

        let updateUrl = `${baseUrl}/update-mcp-config`;
        if (configFilePath) {
          updateUrl += `?path=${encodeURIComponent(configFilePath)}`;
        }

        console.log(`[CredentialsTab:proxy] POST ${updateUrl}`);
        const response = await fetch(updateUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
          body: JSON.stringify({ servers: updatedServers }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error("[CredentialsTab:proxy] Uninstall failed:", errorData);
          throw new Error(
            errorData.message ||
              `HTTP ${response.status}: ${response.statusText}`,
          );
        }

        console.log(
          `[CredentialsTab:proxy] Uninstall success for '${proxyKey}'`,
        );

        if (onServersChange) {
          onServersChange(updatedServers);
        }

        toast({
          title: "Proxy Server Uninstalled",
          description: `${entry.serverName} proxy has been removed from your MCP configuration.`,
        });

        if (onConfigFileUpdated) {
          onConfigFileUpdated();
        }
      } catch (error) {
        console.error("[CredentialsTab:proxy] Uninstall error:", error);
        toast({
          title: "Uninstall Failed",
          description: `Failed to uninstall proxy: ${error instanceof Error ? error.message : String(error)}`,
          variant: "destructive",
        });
      } finally {
        setTimeout(() => setInstallingCredentialId(null), 500);
      }
    },
    [
      config,
      configFilePath,
      currentServers,
      getProxyServerKey,
      onConfigFileUpdated,
      onServersChange,
      toast,
    ],
  );

  // [PROXY] Open the proxy config popup — fetches tools from server
  const handleOpenProxy = useCallback(
    async (entry: CredentialEntry) => {
      console.log(
        `[CredentialsTab:proxy] Opening proxy popup for: ${entry.serverName} (${entry.serverUrl})`,
      );
      setProxyEntry(entry);
      setProxyTools([]);
      setProxySelectedTools(new Set());
      setProxySearchQuery("");
      setProxyToolsLoading(true);

      try {
        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);

        const credentialRecord = getCredentialRecord(rawCredentials, entry);

        const body: Record<string, unknown> = {
          serverUrl: entry.serverUrl,
          accessToken: credentialRecord?.access_token || undefined,
          credentialsFolderPath: credentialsFolderPath || undefined,
        };

        // [PROXY] Provide credentialMeta so the server can auto-refresh if needed
        if (entry.sourceFile && entry.key) {
          body.credentialMeta = {
            folderPath: credentialsFolderPath || "./data",
            sourceFile: entry.sourceFile,
            credentialKey: entry.key,
          };
        }

        console.log(
          `[CredentialsTab:proxy] Fetching tools from ${entry.serverUrl}`,
        );
        const resp = await fetch(`${baseUrl}/credential-server-tools`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          console.error("[CredentialsTab:proxy] Failed to fetch tools:", err);
          toast({
            title: "Failed to Load Tools",
            description:
              err.message || `HTTP ${resp.status}: ${resp.statusText}`,
            variant: "destructive",
          });
          return;
        }

        const data = await resp.json();
        const tools: ProxyToolInfo[] = data.tools || [];
        console.log(
          `[CredentialsTab:proxy] Loaded ${tools.length} tool(s) from ${entry.serverName}`,
        );

        setProxyTools(tools);

        // [PROXY] Load persisted tool selection from server
        const credentialId = getCredentialIdentity(entry);
        try {
          const selResp = await fetch(
            `${baseUrl}/proxy/tool-selection?credentialId=${encodeURIComponent(credentialId)}&folderPath=${encodeURIComponent(credentialsFolderPath || "./data")}`,
            {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                [header]: token ? `Bearer ${token}` : "",
              },
            },
          );
          if (selResp.ok) {
            const selData = await selResp.json();
            if (Array.isArray(selData.selectedTools)) {
              // Intersect persisted selection with available tools
              const availableNames = new Set(tools.map((t) => t.name));
              const persisted = new Set<string>(
                (selData.selectedTools as string[]).filter((n: string) =>
                  availableNames.has(n),
                ),
              );
              console.log(
                `[CredentialsTab:proxy] Restored persisted selection: ${persisted.size}/${tools.length} tool(s)`,
              );
              setProxySelectedTools(persisted);
            } else {
              // No persisted selection — default to all tools
              console.log(
                "[CredentialsTab:proxy] No persisted selection, defaulting to all tools",
              );
              setProxySelectedTools(new Set(tools.map((t) => t.name)));
            }
          } else {
            // Fallback: select all tools
            setProxySelectedTools(new Set(tools.map((t) => t.name)));
          }
        } catch (selError) {
          console.warn(
            "[CredentialsTab:proxy] Failed to load persisted tool selection, defaulting to all:",
            selError,
          );
          setProxySelectedTools(new Set(tools.map((t) => t.name)));
        }
      } catch (error) {
        console.error("[CredentialsTab:proxy] Error fetching tools:", error);
        toast({
          title: "Error",
          description: `Failed to load tools: ${error instanceof Error ? error.message : String(error)}`,
          variant: "destructive",
        });
      } finally {
        setProxyToolsLoading(false);
      }
    },
    [config, credentialsFolderPath, rawCredentials, toast],
  );

  // [PROXY] Close the proxy popup
  const handleCloseProxy = useCallback(() => {
    console.log("[CredentialsTab:proxy] Closing proxy popup");
    setProxyEntry(null);
    setProxyTools([]);
    setProxySelectedTools(new Set());
    setProxySearchQuery("");
  }, []);

  // [PROXY] Persist tool selection to server (fire-and-forget)
  const persistProxyToolSelection = useCallback(
    (credentialId: string, selectedTools: Set<string>) => {
      const baseUrl = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);

      fetch(`${baseUrl}/proxy/tool-selection`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          [header]: token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({
          credentialId,
          selectedTools: [...selectedTools],
          folderPath: credentialsFolderPath || "./data",
        }),
      })
        .then((resp) => {
          if (!resp.ok) {
            console.warn(
              "[CredentialsTab:proxy] Failed to persist tool selection:",
              resp.status,
            );
          } else {
            console.log(
              `[CredentialsTab:proxy] Persisted tool selection for ${credentialId}: ${selectedTools.size} tool(s)`,
            );
          }
        })
        .catch((err) => {
          console.warn(
            "[CredentialsTab:proxy] Error persisting tool selection:",
            err,
          );
        });
    },
    [config, credentialsFolderPath],
  );

  // [PROXY] Toggle a tool in the proxy selection
  const handleToggleProxyTool = useCallback(
    (toolName: string) => {
      setProxySelectedTools((prev) => {
        const next = new Set(prev);
        if (next.has(toolName)) {
          next.delete(toolName);
          console.log(`[CredentialsTab:proxy] Deselected tool: ${toolName}`);
        } else {
          next.add(toolName);
          console.log(`[CredentialsTab:proxy] Selected tool: ${toolName}`);
        }
        // Persist the updated selection
        if (proxyEntry) {
          const credentialId = getCredentialIdentity(proxyEntry);
          persistProxyToolSelection(credentialId, next);
        }
        return next;
      });
    },
    [proxyEntry, persistProxyToolSelection],
  );

  // [PROXY] Select / deselect all tools
  const handleSelectAllProxyTools = useCallback(() => {
    const allNames = proxyTools.map((t) => t.name);
    const allSelected = allNames.every((n) => proxySelectedTools.has(n));
    let nextSet: Set<string>;
    if (allSelected) {
      console.log("[CredentialsTab:proxy] Deselecting all tools");
      nextSet = new Set();
    } else {
      console.log("[CredentialsTab:proxy] Selecting all tools");
      nextSet = new Set(allNames);
    }
    setProxySelectedTools(nextSet);
    // Persist the updated selection
    if (proxyEntry) {
      const credentialId = getCredentialIdentity(proxyEntry);
      persistProxyToolSelection(credentialId, nextSet);
    }
  }, [proxyTools, proxySelectedTools, proxyEntry, persistProxyToolSelection]);

  // [PROXY] Copy MCP server config JSON to clipboard
  const handleCopyProxyConfig = useCallback(() => {
    if (!proxyEntry) return;

    const proxyKey = getProxyServerKey(proxyEntry);

    // [PROXY] Point to the LOCAL proxy server, NOT the remote server directly.
    // Include credential identity so the proxy can load the exact credential.
    const proxyBaseUrl = getMCPProxyAddress(config);
    const proxyParams = new URLSearchParams({
      url: proxyEntry.serverUrl,
      transportType: "streamable-http",
      credentialFile: proxyEntry.sourceFile,
      credentialKey: proxyEntry.key,
    });
    // [PROXY] Include allowed tools in proxy URL if not all are selected
    if (
      proxySelectedTools.size > 0 &&
      proxySelectedTools.size < proxyTools.length
    ) {
      proxyParams.set("allowedTools", [...proxySelectedTools].join(","));
    }
    const proxyUrl = `${proxyBaseUrl}/mcp?${proxyParams.toString()}`;
    // [PROXY] Antigravity/Gemini CLI uses "serverUrl" key; others (Cursor) use "url"
    const isAntigravity =
      configFilePath?.includes("antigravity") ||
      configFilePath?.includes("gemini");
    const urlKey = isAntigravity ? "serverUrl" : "url";
    const serverConfig: Record<string, unknown> = {
      [urlKey]: proxyUrl,
      type: "streamable-http",
    };

    const configJson = JSON.stringify(
      {
        mcpServers: {
          [proxyKey]: serverConfig,
        },
      },
      null,
      2,
    );

    console.log(`[CredentialsTab:proxy] Copying MCP config for ${proxyKey}`);
    navigator.clipboard.writeText(configJson);
    toast({
      title: "Copied",
      description: "MCP server config copied to clipboard",
    });
  }, [
    proxyEntry,
    getProxyServerKey,
    config,
    configFilePath,
    proxySelectedTools,
    proxyTools,
    toast,
  ]);

  // [PROXY] Copy curl command to clipboard
  const handleCopyCurl = useCallback(() => {
    if (!proxyEntry) return;

    const credentialRecord = getCredentialRecord(rawCredentials, proxyEntry);
    const selectedToolNames = [...proxySelectedTools];

    // Generate a curl command for each selected tool (or one with wildcard)
    const toolName =
      selectedToolNames.length === 1
        ? selectedToolNames[0]
        : selectedToolNames.length === proxyTools.length
          ? "*"
          : selectedToolNames.join(",");

    const baseUrl = getMCPProxyAddress(config);

    const curlParts = [
      `curl -X POST ${baseUrl}/execute-tool \\`,
      `  -H "Content-Type: application/json" \\`,
    ];

    if (credentialRecord?.access_token) {
      curlParts.push(
        `  -H "Authorization: Bearer ${credentialRecord.access_token}" \\`,
      );
    }

    const bodyObj: Record<string, unknown> = {
      toolName,
      toolArgs: {},
      server: {
        name: proxyEntry.serverName,
        type: "streamable-http",
        url: proxyEntry.serverUrl,
      },
    };

    curlParts.push(`  -d '${JSON.stringify(bodyObj, null, 2)}'`);

    const curl = curlParts.join("\n");
    console.log(
      `[CredentialsTab:proxy] Copying curl for ${proxyEntry.serverName}, tool=${toolName}`,
    );
    navigator.clipboard.writeText(curl);
    toast({
      title: "Copied",
      description: "Curl command copied to clipboard",
    });
  }, [
    config,
    proxyEntry,
    proxySelectedTools,
    proxyTools,
    rawCredentials,
    toast,
  ]);

  // Compute expiry status for a credential
  const getExpiryStatus = (
    entry: CredentialEntry,
  ): {
    icon: React.ReactNode;
    label: string;
    color: string;
    tooltip: string;
  } => {
    if (!entry.expiresAt) {
      return {
        icon: <AlertTriangle className="w-4 h-4" />,
        label: "No expiry info",
        color: "text-yellow-500",
        tooltip: "No expiration timestamp available",
      };
    }

    const expiryDate = new Date(entry.expiresAt);
    const formattedDate = expiryDate.toLocaleString();
    const now = Date.now();
    const msLeft = entry.expiresAt - now;

    if (msLeft <= 0) {
      const agoMs = Math.abs(msLeft);
      return {
        icon: <XCircle className="w-4 h-4" />,
        label: "Expired",
        color: "text-red-500",
        tooltip: `Expired at ${formattedDate} (${formatDuration(agoMs)} ago)`,
      };
    }

    if (msLeft < 60_000) {
      return {
        icon: <AlertTriangle className="w-4 h-4" />,
        label: `Expires in ${formatDuration(msLeft)}`,
        color: "text-red-500",
        tooltip: `Expires at ${formattedDate}`,
      };
    }

    if (msLeft < 300_000) {
      return {
        icon: <Clock className="w-4 h-4" />,
        label: `Expires in ${formatDuration(msLeft)}`,
        color: "text-yellow-500",
        tooltip: `Expires at ${formattedDate}`,
      };
    }

    return {
      icon: <CheckCircle2 className="w-4 h-4" />,
      label: `Valid for ${formatDuration(msLeft)}`,
      color: "text-green-500",
      tooltip: `Expires at ${formattedDate}`,
    };
  };

  // Group entries by source file for display
  const entriesByFile = entries.reduce(
    (acc, entry) => {
      const file = entry.sourceFile || "unknown";
      if (!acc[file]) acc[file] = [];
      acc[file].push(entry);
      return acc;
    },
    {} as Record<string, CredentialEntry[]>,
  );

  return (
    <TabsContent value="credentials">
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5" />
            <h2 className="text-lg font-semibold">Credentials</h2>
            {entries.length > 0 && (
              <Badge variant="secondary">{entries.length}</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleChooseFolder}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <FolderOpen className="w-4 h-4 mr-2" />
              )}
              {credentialsFolderPath ? "Change Folder" : "Choose Folder"}
            </Button>
            {credentialsFolderPath && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadCredentials()}
                disabled={isLoading}
              >
                <RefreshCw
                  className={`w-4 h-4 mr-2 ${isLoading ? "animate-spin" : ""}`}
                />
                Reload
              </Button>
            )}
          </div>
        </div>

        {/* Folder path display */}
        {credentialsFolderPath && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
            <FolderOpen className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{credentialsFolderPath}</span>
            {Object.keys(entriesByFile).length > 0 && (
              <Badge variant="outline" className="text-xs shrink-0">
                {Object.keys(entriesByFile).length} file(s)
              </Badge>
            )}
          </div>
        )}

        {/* Drag-and-drop overlay */}
        {isDragOver && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
            <div className="border-2 border-dashed border-primary rounded-xl p-12 flex flex-col items-center gap-3 bg-primary/5">
              <Upload className="w-12 h-12 text-primary animate-bounce" />
              <p className="text-lg font-medium text-primary">
                Drop credentials file here
              </p>
              <p className="text-sm text-muted-foreground">
                {credentialsFolderPath
                  ? `File will be saved to ${credentialsFolderPath}`
                  : "File will be saved to ./data/"}
              </p>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!credentialsFolderPath && !isDragOver && (
          <Card>
            <CardContent className="py-8">
              <div className="flex flex-col items-center justify-center text-center space-y-3">
                <Shield className="w-12 h-12 text-muted-foreground/30" />
                <div>
                  <p className="text-lg font-medium text-muted-foreground">
                    No Credentials Folder Selected
                  </p>
                  <p className="text-sm text-muted-foreground/70 mt-1 max-w-md">
                    Choose a folder containing <code>.json</code> credential
                    files to manage OAuth tokens for MCP servers. Each JSON file
                    in the folder will be loaded as a separate credential
                    source.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="default" onClick={handleChooseFolder}>
                    <FolderOpen className="w-4 h-4 mr-2" />
                    Choose Folder
                  </Button>
                  <span className="text-sm text-muted-foreground">or</span>
                  <div className="border-2 border-dashed border-muted-foreground/30 rounded-lg px-4 py-2 text-sm text-muted-foreground">
                    Drag & drop .json files here
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Credentials list, grouped by source file */}
        {Object.keys(entriesByFile).length > 0 && (
          <div className="space-y-4">
            {Object.entries(entriesByFile).map(([fileName, fileEntries]) => (
              <div key={fileName} className="space-y-2">
                {/* File header */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                  <FileText className="w-3.5 h-3.5" />
                  <span className="font-medium">{fileName}</span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {fileEntries.length}
                  </Badge>
                </div>

                {/* Entries for this file */}
                {fileEntries.map((entry) => {
                  const credentialId = getCredentialIdentity(entry);
                  const credentialRecord = getCredentialRecord(
                    rawCredentials,
                    entry,
                  );
                  const isEnabled =
                    enabledCredentials.has(credentialId) ||
                    enabledCredentials.has(entry.key);
                  const expiryStatus = getExpiryStatus(entry);
                  const isRefreshing = refreshingKey === credentialId;

                  return (
                    <Card
                      key={credentialId}
                      className={`transition-all duration-200 ${
                        !isEnabled ? "opacity-50 bg-muted/30" : ""
                      }`}
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <Server className="w-5 h-5 text-muted-foreground" />
                            <div className="min-w-0">
                              <CardTitle className="flex items-center gap-1.5 text-base">
                                <span className="truncate">
                                  {entry.serverName}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0"
                                  onClick={() =>
                                    handleOpenCredentialNameDialog(entry)
                                  }
                                  title="Edit credential name"
                                  aria-label={`Edit ${entry.serverName} credential name`}
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </Button>
                              </CardTitle>
                              <CardDescription className="flex items-center gap-1.5 mt-0.5">
                                <Globe className="w-3 h-3" />
                                <span className="truncate max-w-[300px]">
                                  {entry.serverUrl}
                                </span>
                              </CardDescription>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {/* Expiry status */}
                            <div
                              className={`flex items-center gap-1.5 text-xs cursor-default ${expiryStatus.color}`}
                              title={expiryStatus.tooltip}
                            >
                              {expiryStatus.icon}
                              <span>{expiryStatus.label}</span>
                            </div>
                            {/* Refresh button */}
                            {entry.hasRefreshToken && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRefreshToken(entry)}
                                disabled={isRefreshing || !isEnabled}
                                title="Refresh token"
                              >
                                {isRefreshing ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="w-4 h-4" />
                                )}
                              </Button>
                            )}
                            {/* Enable/disable toggle */}
                            <Switch
                              checked={isEnabled}
                              onCheckedChange={() =>
                                handleToggleCredential(entry)
                              }
                            />
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="pt-0 pb-3">
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={!isEnabled || !entry.hasAccessToken}
                            onClick={() => handleTestConnection(entry)}
                            title="Test connection to server"
                          >
                            <Zap className="w-3.5 h-3.5 mr-1" />
                            Test
                          </Button>
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                              >
                                <Info className="w-3.5 h-3.5 mr-1" />
                                Info
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-lg max-h-[80vh] overflow-auto">
                              <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                  <Server className="w-5 h-5" />
                                  {entry.serverName}
                                </DialogTitle>
                                <DialogDescription className="flex items-center gap-1.5">
                                  <Globe className="w-3 h-3" />
                                  {entry.serverUrl}
                                </DialogDescription>
                              </DialogHeader>
                              <div className="space-y-4 mt-2">
                                {/* Source file */}
                                <div>
                                  <p className="text-xs font-medium text-muted-foreground mb-1">
                                    Source File
                                  </p>
                                  <p className="text-sm font-mono bg-muted px-3 py-1.5 rounded">
                                    {entry.sourceFile}
                                  </p>
                                </div>

                                {/* Access Token */}
                                <div>
                                  <div className="flex items-center justify-between mb-1">
                                    <p className="text-xs font-medium text-muted-foreground">
                                      Access Token
                                    </p>
                                    {entry.hasAccessToken &&
                                      credentialRecord?.access_token && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-6 px-2 text-xs"
                                          onClick={() => {
                                            navigator.clipboard.writeText(
                                              credentialRecord.access_token,
                                            );
                                            toast({
                                              title: "Copied",
                                              description:
                                                "Access token copied to clipboard",
                                            });
                                          }}
                                        >
                                          <Copy className="w-3 h-3 mr-1" />
                                          Copy
                                        </Button>
                                      )}
                                  </div>
                                  {entry.hasAccessToken ? (
                                    <p className="text-sm font-mono bg-muted px-3 py-1.5 rounded break-all max-h-20 overflow-auto">
                                      {credentialRecord?.access_token
                                        ? `${credentialRecord.access_token.substring(0, 50)}...`
                                        : "Available"}
                                    </p>
                                  ) : (
                                    <p className="text-sm text-destructive">
                                      Not available
                                    </p>
                                  )}
                                </div>

                                {/* Refresh Token */}
                                {entry.hasRefreshToken && (
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <p className="text-xs font-medium text-muted-foreground">
                                        Refresh Token
                                      </p>
                                      {credentialRecord?.refresh_token && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-6 px-2 text-xs"
                                          onClick={() => {
                                            navigator.clipboard.writeText(
                                              credentialRecord.refresh_token,
                                            );
                                            toast({
                                              title: "Copied",
                                              description:
                                                "Refresh token copied to clipboard",
                                            });
                                          }}
                                        >
                                          <Copy className="w-3 h-3 mr-1" />
                                          Copy
                                        </Button>
                                      )}
                                    </div>
                                    <p className="text-sm font-mono bg-muted px-3 py-1.5 rounded break-all max-h-20 overflow-auto">
                                      {credentialRecord?.refresh_token
                                        ? `${credentialRecord.refresh_token.substring(0, 50)}...`
                                        : "Available"}
                                    </p>
                                  </div>
                                )}

                                {/* Client ID */}
                                {entry.clientId && (
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <p className="text-xs font-medium text-muted-foreground">
                                        Client ID
                                      </p>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-2 text-xs"
                                        onClick={() => {
                                          navigator.clipboard.writeText(
                                            entry.clientId,
                                          );
                                          toast({
                                            title: "Copied",
                                            description:
                                              "Client ID copied to clipboard",
                                          });
                                        }}
                                      >
                                        <Copy className="w-3 h-3 mr-1" />
                                        Copy
                                      </Button>
                                    </div>
                                    <p className="text-sm font-mono bg-muted px-3 py-1.5 rounded break-all">
                                      {entry.clientId}
                                    </p>
                                  </div>
                                )}

                                {/* Scopes */}
                                {entry.scopes.length > 0 && (
                                  <div>
                                    <p className="text-xs font-medium text-muted-foreground mb-2">
                                      Scopes ({entry.scopes.length})
                                    </p>
                                    <div className="flex flex-wrap gap-1 max-h-48 overflow-auto">
                                      {entry.scopes.map((scope) => (
                                        <Badge
                                          key={scope}
                                          variant="secondary"
                                          className="text-[10px] font-mono"
                                        >
                                          {scope}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Expiry */}
                                <div>
                                  <p className="text-xs font-medium text-muted-foreground mb-1">
                                    Expiry Status
                                  </p>
                                  <div
                                    className={`flex items-center gap-1.5 text-sm ${expiryStatus.color}`}
                                  >
                                    {expiryStatus.icon}
                                    <span>{expiryStatus.label}</span>
                                    {entry.expiresAt && (
                                      <span className="text-xs text-muted-foreground ml-2">
                                        (
                                        {new Date(
                                          entry.expiresAt,
                                        ).toLocaleString()}
                                        )
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </DialogContent>
                          </Dialog>
                          {/* [PROXY] Install / Uninstall / Proxy buttons */}
                          {(() => {
                            const installed = isCredentialInstalled(entry);
                            const isInstalling =
                              installingCredentialId === credentialId;
                            return (
                              <>
                                {installed ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                    onClick={() =>
                                      handleUninstallCredential(entry)
                                    }
                                    disabled={isInstalling}
                                    title="Uninstall proxy server from MCP config"
                                  >
                                    {isInstalling ? (
                                      <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                                    ) : (
                                      <Trash2 className="w-3.5 h-3.5 mr-1" />
                                    )}
                                    Uninstall
                                  </Button>
                                ) : (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() =>
                                      handleInstallCredential(entry)
                                    }
                                    disabled={
                                      isInstalling ||
                                      !isEnabled ||
                                      !entry.serverUrl
                                    }
                                    title="Install proxy server to MCP config"
                                  >
                                    {isInstalling ? (
                                      <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                                    ) : (
                                      <Download className="w-3.5 h-3.5 mr-1" />
                                    )}
                                    Install
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => handleOpenProxy(entry)}
                                  disabled={!isEnabled || !entry.serverUrl}
                                  title="Open proxy config popup"
                                >
                                  <Network className="w-3.5 h-3.5 mr-1" />
                                  Proxy
                                </Button>
                              </>
                            );
                          })()}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Loading state when folder is set but entries empty */}
        {credentialsFolderPath && entries.length === 0 && !isLoading && (
          <Card>
            <CardContent className="py-6">
              <div className="flex flex-col items-center justify-center text-center space-y-2">
                <AlertTriangle className="w-8 h-8 text-yellow-500/50" />
                <p className="text-sm text-muted-foreground">
                  No .json credential files found in the folder.
                </p>
                <p className="text-xs text-muted-foreground/70">
                  Drop .json files here or add them to the folder.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <Dialog
          open={!!editingEntry}
          onOpenChange={handleCredentialNameDialogOpenChange}
        >
          <DialogContent className="max-w-md">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveCredentialName();
              }}
            >
              <DialogHeader>
                <DialogTitle>Edit Credential Name</DialogTitle>
                <DialogDescription>
                  Update the display name stored in the credential file.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Input
                  value={credentialNameDraft}
                  onChange={(event) =>
                    setCredentialNameDraft(event.target.value)
                  }
                  placeholder="Credential name"
                  autoFocus
                  disabled={isSavingCredentialName}
                />
                {editingEntry && (
                  <p className="text-xs text-muted-foreground">
                    {editingEntry.sourceFile}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeCredentialNameDialog}
                  disabled={isSavingCredentialName}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    isSavingCredentialName || !credentialNameDraft.trim()
                  }
                >
                  {isSavingCredentialName && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* [PROXY] Proxy config popup */}
        <Dialog
          open={!!proxyEntry}
          onOpenChange={(open) => {
            if (!open) handleCloseProxy();
          }}
        >
          <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Network className="w-5 h-5" />
                Proxy Config — {proxyEntry?.serverName}
              </DialogTitle>
              <DialogDescription className="flex items-center gap-1.5">
                <Globe className="w-3 h-3" />
                {proxyEntry?.serverUrl}
              </DialogDescription>
            </DialogHeader>

            {/* [PROXY] Search input */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={proxySearchQuery}
                onChange={(e) => setProxySearchQuery(e.target.value)}
                placeholder="Search tools..."
                className="pl-9 h-8 text-sm"
              />
            </div>

            {/* [PROXY] Select all / count */}
            {proxyTools.length > 0 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <button
                  onClick={handleSelectAllProxyTools}
                  className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                >
                  {proxyTools.every((t) => proxySelectedTools.has(t.name)) ? (
                    <CheckSquare className="w-3.5 h-3.5" />
                  ) : (
                    <Square className="w-3.5 h-3.5" />
                  )}
                  {proxyTools.every((t) => proxySelectedTools.has(t.name))
                    ? "Deselect all"
                    : "Select all"}
                </button>
                <span>
                  {proxySelectedTools.size}/{proxyTools.length} selected
                </span>
              </div>
            )}

            {/* [PROXY] Tools list */}
            <div className="flex-1 overflow-auto border rounded-md max-h-[300px]">
              {proxyToolsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">
                    Loading tools...
                  </span>
                </div>
              ) : proxyTools.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                  No tools found
                </div>
              ) : (
                <div className="divide-y">
                  {proxyTools
                    .filter(
                      (tool) =>
                        !proxySearchQuery ||
                        tool.name
                          .toLowerCase()
                          .includes(proxySearchQuery.toLowerCase()) ||
                        tool.description
                          ?.toLowerCase()
                          .includes(proxySearchQuery.toLowerCase()),
                    )
                    .map((tool) => (
                      <label
                        key={tool.name}
                        className="flex items-start gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer transition-colors"
                      >
                        <Checkbox
                          checked={proxySelectedTools.has(tool.name)}
                          onCheckedChange={() =>
                            handleToggleProxyTool(tool.name)
                          }
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">
                            {tool.name}
                          </p>
                          {tool.description && (
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {tool.description}
                            </p>
                          )}
                        </div>
                      </label>
                    ))}
                </div>
              )}
            </div>

            {/* [PROXY] Footer actions */}
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyProxyConfig}
                disabled={!proxyEntry}
              >
                <Copy className="w-3.5 h-3.5 mr-1.5" />
                Copy MCP Config
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyCurl}
                disabled={!proxyEntry || proxySelectedTools.size === 0}
              >
                <Copy className="w-3.5 h-3.5 mr-1.5" />
                Copy curl
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCloseProxy}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TabsContent>
  );
};

export default CredentialsTab;
export type { RawCredentials, CredentialEntry };
