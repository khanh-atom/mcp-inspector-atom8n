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
  Shield,
  Upload,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  FileText,
  Server,
  Key,
  Globe,
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
  };
}

interface CredentialsTabProps {
  config: InspectorConfig;
  credentialsFilePath: string;
  setCredentialsFilePath: (path: string) => void;
  enabledCredentials: Set<string>;
  setEnabledCredentials: (keys: Set<string>) => void;
  rawCredentials: RawCredentials | null;
  setRawCredentials: (creds: RawCredentials | null) => void;
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
  credentialsFilePath,
  setCredentialsFilePath,
  enabledCredentials,
  setEnabledCredentials,
  rawCredentials,
  setRawCredentials,
}: CredentialsTabProps) => {
  const [entries, setEntries] = useState<CredentialEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const { toast } = useToast();

  // [CREDENTIALS] Log component render state
  console.log("[CredentialsTab] Render", {
    credentialsFilePath,
    entriesCount: entries.length,
    enabledCount: enabledCredentials.size,
    hasRawCredentials: !!rawCredentials,
  });

  // Load credentials from file
  const loadCredentials = useCallback(
    async (filePath?: string) => {
      const pathToLoad = filePath || credentialsFilePath;
      if (!pathToLoad) {
        console.log("[CredentialsTab] No credentials file path, skipping load");
        return;
      }

      setIsLoading(true);
      console.log(`[CredentialsTab] Loading credentials from: ${pathToLoad}`);

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
          `[CredentialsTab] Loaded ${data.count} credential(s)`,
          data.entries?.map((e: CredentialEntry) => e.serverName),
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
      credentialsFilePath,
      enabledCredentials.size,
      setEnabledCredentials,
      setRawCredentials,
      toast,
    ],
  );

  // Load credentials on mount if path exists
  useEffect(() => {
    if (credentialsFilePath) {
      console.log(
        "[CredentialsTab] Auto-loading credentials on mount/path change",
      );
      loadCredentials();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialsFilePath]);

  // Handle choosing a file via native picker
  const handleChooseFile = useCallback(async () => {
    console.log("[CredentialsTab] Opening file picker");
    try {
      const baseUrl = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      const resp = await fetch(`${baseUrl}/credentials/choose-file`, {
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
            "[CredentialsTab] File chosen:",
            data.path,
            data.absolutePath,
          );
          setCredentialsFilePath(data.path);
          localStorage.setItem("credentialsFilePath", data.path);
          loadCredentials(data.path);
        } else {
          console.log("[CredentialsTab] File picker cancelled");
        }
      }
    } catch (err) {
      console.error("[CredentialsTab] Error choosing file:", err);
      toast({
        title: "Error",
        description: "Failed to open file picker",
        variant: "destructive",
      });
    }
  }, [config, setCredentialsFilePath, loadCredentials, toast]);

  // [DRAG-DROP] Handle file drop — read content and upload to server
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
          `[CredentialsTab:dragDrop] Upload success: path=${data.path}, count=${data.count}`,
        );

        // Update state with the uploaded data
        setCredentialsFilePath(data.path);
        localStorage.setItem("credentialsFilePath", data.path);
        setEntries(data.entries || []);
        setRawCredentials(data.credentials || null);

        // Auto-enable all credentials
        if (data.entries?.length > 0) {
          const allKeys = new Set<string>(
            data.entries.map((e: CredentialEntry) => e.key),
          );
          setEnabledCredentials(allKeys);
          localStorage.setItem(
            "enabledCredentials",
            JSON.stringify([...allKeys]),
          );
        }

        toast({
          title: "Credentials Loaded",
          description: `Loaded ${data.count} credential(s) from ${file.name}`,
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
      setCredentialsFilePath,
      setEnabledCredentials,
      setRawCredentials,
      toast,
    ],
  );

  // [DRAG-DROP] Window-level event listeners to prevent browser default file-open
  // React event handlers alone are insufficient because the browser intercepts
  // the drop at the window level before it reaches any React element.
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
    async (credentialKey: string) => {
      if (!credentialsFilePath) return;

      console.log(`[CredentialsTab] Refreshing token for: ${credentialKey}`);
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
            path: credentialsFilePath,
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
    [config, credentialsFilePath, loadCredentials, toast],
  );

  // Compute expiry status for a credential
  const getExpiryStatus = (
    entry: CredentialEntry,
  ): { icon: React.ReactNode; label: string; color: string } => {
    if (!entry.expiresAt) {
      return {
        icon: <AlertTriangle className="w-4 h-4" />,
        label: "No expiry info",
        color: "text-yellow-500",
      };
    }

    const now = Date.now();
    const msLeft = entry.expiresAt - now;

    if (msLeft <= 0) {
      return {
        icon: <XCircle className="w-4 h-4" />,
        label: "Expired",
        color: "text-red-500",
      };
    }

    if (msLeft < 60_000) {
      return {
        icon: <AlertTriangle className="w-4 h-4" />,
        label: `Expires in ${formatDuration(msLeft)}`,
        color: "text-red-500",
      };
    }

    if (msLeft < 300_000) {
      return {
        icon: <Clock className="w-4 h-4" />,
        label: `Expires in ${formatDuration(msLeft)}`,
        color: "text-yellow-500",
      };
    }

    return {
      icon: <CheckCircle2 className="w-4 h-4" />,
      label: `Valid for ${formatDuration(msLeft)}`,
      color: "text-green-500",
    };
  };

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
              onClick={handleChooseFile}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-2" />
              )}
              {credentialsFilePath ? "Change File" : "Load Credentials"}
            </Button>
            {credentialsFilePath && (
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

        {/* File path display */}
        {credentialsFilePath && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
            <FileText className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{credentialsFilePath}</span>
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
                Supports .json credential files
              </p>
            </div>
          </div>
        )}

        {/* Empty state — with drag-drop hint */}
        {!credentialsFilePath && !isDragOver && (
          <Card>
            <CardContent className="py-8">
              <div className="flex flex-col items-center justify-center text-center space-y-3">
                <Shield className="w-12 h-12 text-muted-foreground/30" />
                <div>
                  <p className="text-lg font-medium text-muted-foreground">
                    No Credentials Loaded
                  </p>
                  <p className="text-sm text-muted-foreground/70 mt-1 max-w-md">
                    Load a <code>.credentials.json</code> file to manage OAuth
                    tokens for MCP servers like Datadog. Credentials will be
                    automatically injected when executing tools.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="default" onClick={handleChooseFile}>
                    <Upload className="w-4 h-4 mr-2" />
                    Choose File
                  </Button>
                  <span className="text-sm text-muted-foreground">or</span>
                  <div className="border-2 border-dashed border-muted-foreground/30 rounded-lg px-4 py-2 text-sm text-muted-foreground">
                    Drag & drop a .json file here
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Credentials list */}
        {entries.length > 0 && (
          <div className="space-y-3">
            {entries.map((entry) => {
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
                          className={`flex items-center gap-1.5 text-xs ${expiryStatus.color}`}
                        >
                          {expiryStatus.icon}
                          <span>{expiryStatus.label}</span>
                        </div>
                        {/* Refresh button */}
                        {entry.hasRefreshToken && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRefreshToken(entry.key)}
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
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant={
                          entry.hasAccessToken ? "default" : "destructive"
                        }
                        className="text-xs"
                      >
                        <Key className="w-3 h-3 mr-1" />
                        {entry.hasAccessToken
                          ? "Access Token"
                          : "No Access Token"}
                      </Badge>
                      {entry.hasRefreshToken && (
                        <Badge variant="outline" className="text-xs">
                          <RefreshCw className="w-3 h-3 mr-1" />
                          Refresh Token
                        </Badge>
                      )}
                      {entry.scopes.length > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {entry.scopes.length} scopes
                        </Badge>
                      )}
                      {entry.clientId && (
                        <Badge variant="outline" className="text-xs font-mono">
                          {entry.clientId.substring(0, 20)}...
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Loading state when file is loaded but entries empty */}
        {credentialsFilePath && entries.length === 0 && !isLoading && (
          <Card>
            <CardContent className="py-6">
              <div className="flex flex-col items-center justify-center text-center space-y-2">
                <AlertTriangle className="w-8 h-8 text-yellow-500/50" />
                <p className="text-sm text-muted-foreground">
                  No credential entries found in the file.
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
