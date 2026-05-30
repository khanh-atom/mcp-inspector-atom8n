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
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
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
} from "lucide-react";
import { useToast } from "../lib/hooks/useToast";
import { InspectorConfig } from "@/lib/configurationTypes";
import { getMCPProxyAddress, getMCPProxyAuthToken } from "@/utils/configUtils";

/** Shape of a single credential entry as returned by GET /credentials */
interface CredentialEntry {
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
  };
}

interface CredentialsTabProps {
  config: InspectorConfig;
  credentialsFolderPath: string;
  setCredentialsFolderPath: (path: string) => void;
  enabledCredentials: Set<string>;
  setEnabledCredentials: (keys: Set<string>) => void;
  rawCredentials: RawCredentials | null;
  setRawCredentials: (creds: RawCredentials | null) => void;
  onTestConnection?: (serverConfig: any) => void;
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

const CredentialsTab = ({
  config,
  credentialsFolderPath,
  setCredentialsFolderPath,
  enabledCredentials,
  setEnabledCredentials,
  rawCredentials,
  setRawCredentials,
  onTestConnection,
}: CredentialsTabProps) => {
  const [entries, setEntries] = useState<CredentialEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const { toast } = useToast();

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

        setEntries(data.entries || []);
        setRawCredentials(data.credentials || null);

        // Auto-enable all credentials on first load if none are enabled
        if (enabledCredentials.size === 0 && data.entries?.length > 0) {
          const allKeys = new Set<string>(
            data.entries.map((e: CredentialEntry) => e.key),
          );
          console.log("[CredentialsTab] Auto-enabling all credentials:", [
            ...allKeys,
          ]);
          setEnabledCredentials(allKeys);
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
      enabledCredentials.size,
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
    (key: string) => {
      const newEnabled = new Set(enabledCredentials);
      if (newEnabled.has(key)) {
        console.log(`[CredentialsTab] Disabling credential: ${key}`);
        newEnabled.delete(key);
      } else {
        console.log(`[CredentialsTab] Enabling credential: ${key}`);
        newEnabled.add(key);
      }
      setEnabledCredentials(newEnabled);
      localStorage.setItem(
        "enabledCredentials",
        JSON.stringify([...newEnabled]),
      );
    },
    [enabledCredentials, setEnabledCredentials],
  );

  // Refresh a credential's token
  const handleRefreshToken = useCallback(
    async (credentialKey: string, sourceFile: string) => {
      if (!credentialsFolderPath) return;

      console.log(
        `[CredentialsTab] Refreshing token for: ${credentialKey} in file: ${sourceFile}`,
      );
      setRefreshingKey(credentialKey);

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
            sourceFile,
            credentialKey,
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
          description: `Token for ${credentialKey.split("|")[0]} refreshed. Expires in ${formatDuration(data.expiresInMs)}`,
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

  // Test connection to a server — delegates to App's handleTestConnection
  const handleTestConnection = useCallback(
    (entry: CredentialEntry) => {
      if (!entry.serverUrl) {
        toast({
          title: "Cannot Test",
          description: "Missing server URL",
          variant: "destructive",
        });
        return;
      }

      console.log(`[CredentialsTab] Testing connection to: ${entry.serverUrl}`);

      if (onTestConnection) {
        // Build a server config matching what App.handleTestConnection expects
        // Include the stored access token so the connection is authenticated
        const cred = rawCredentials?.[entry.key];
        onTestConnection({
          type: "streamable-http",
          url: entry.serverUrl,
          bearerToken: cred?.access_token || undefined,
        });
      } else {
        toast({
          title: "Test Connection",
          description: `Would connect to ${entry.serverName} at ${entry.serverUrl}`,
        });
      }
    },
    [onTestConnection, toast],
  );

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
                  const isEnabled = enabledCredentials.has(entry.key);
                  const expiryStatus = getExpiryStatus(entry);
                  const isRefreshing = refreshingKey === entry.key;

                  return (
                    <Card
                      key={entry.key}
                      className={`transition-all duration-200 ${
                        !isEnabled ? "opacity-50 bg-muted/30" : ""
                      }`}
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <Server className="w-5 h-5 text-muted-foreground" />
                            <div>
                              <CardTitle className="text-base">
                                {entry.serverName}
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
                                onClick={() =>
                                  handleRefreshToken(
                                    entry.key,
                                    entry.sourceFile,
                                  )
                                }
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
                                handleToggleCredential(entry.key)
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
                                      rawCredentials?.[entry.key]
                                        ?.access_token && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-6 px-2 text-xs"
                                          onClick={() => {
                                            navigator.clipboard.writeText(
                                              rawCredentials[entry.key]
                                                .access_token,
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
                                      {rawCredentials?.[entry.key]?.access_token
                                        ? `${rawCredentials[entry.key].access_token.substring(0, 50)}...`
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
                                      {rawCredentials?.[entry.key]
                                        ?.refresh_token && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-6 px-2 text-xs"
                                          onClick={() => {
                                            navigator.clipboard.writeText(
                                              rawCredentials[entry.key]
                                                .refresh_token,
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
                                      {rawCredentials?.[entry.key]
                                        ?.refresh_token
                                        ? `${rawCredentials[entry.key].refresh_token.substring(0, 50)}...`
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
      </div>
    </TabsContent>
  );
};

export default CredentialsTab;
export type { RawCredentials, CredentialEntry };
