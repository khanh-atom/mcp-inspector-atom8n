import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import DynamicJsonForm, { DynamicJsonFormRef } from "./DynamicJsonForm";
import type { JsonValue, JsonSchemaType } from "@/utils/jsonUtils";
import {
  generateDefaultValue,
  isPropertyRequired,
  normalizeUnionType,
} from "@/utils/schemaUtils";
import {
  CompatibilityCallToolResult,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Loader2,
  Send,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Copy,
  CheckCheck,
  Terminal,
  PlayCircle,
  ExternalLink,
} from "lucide-react";
import { useEffect, useState, useRef, useCallback } from "react";
import { InspectorConfig } from "@/lib/configurationTypes";
import { getMCPProxyAddress, getMCPProxyAuthToken } from "@/utils/configUtils";
import ListPane from "./ListPane";
import JsonView from "./JsonView";
import ToolResults from "./ToolResults";
import ToolRunDetailDialog, { type ToolRunData } from "./ToolRunDetailDialog";
import type { RawCredentials } from "./CredentialsTab";
import { useToast } from "@/lib/hooks/useToast";
import useCopy from "@/lib/hooks/useCopy";
import {
  copyToClipboard,
  getClipboardErrorMessage,
} from "@/utils/clipboardUtils";

// Type guard to safely detect the optional _meta field without using `any`
const hasMeta = (tool: Tool): tool is Tool & { _meta: unknown } =>
  typeof (tool as { _meta?: unknown })._meta !== "undefined";

const normalizeCredentialUrl = (value: unknown): string | null => {
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
};

const readEnabledCredentialKeysFromStorage = (): string[] => {
  try {
    const saved = localStorage.getItem("enabledCredentials");
    return saved ? (JSON.parse(saved) as string[]) : [];
  } catch (error) {
    console.warn("[ToolsTab] Failed to read enabledCredentials", error);
    return [];
  }
};

const ToolsTab = ({
  tools,
  listTools,
  clearTools,
  callTool,
  selectedTool,
  setSelectedTool,
  toolResult,
  nextCursor,
  error,
  resourceContent,
  onReadResource,
  currentServerConfig,
  loadedServers,
  config,
  credentialsFolderPath,
  enabledCredentials,
  rawCredentials,
}: {
  tools: Tool[];
  listTools: () => void;
  clearTools: () => void;
  callTool: (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{ success: boolean; result: CompatibilityCallToolResult }>;
  selectedTool: Tool | null;
  setSelectedTool: (tool: Tool | null) => void;
  toolResult: CompatibilityCallToolResult | null;
  nextCursor: ListToolsResult["nextCursor"];
  error: string | null;
  resourceContent: Record<string, string>;
  onReadResource?: (uri: string) => void;
  currentServerConfig?: Record<string, unknown>;
  loadedServers?: Record<string, any>;
  config?: InspectorConfig;
  credentialsFolderPath?: string;
  enabledCredentials?: Set<string>;
  rawCredentials?: RawCredentials | null;
}) => {
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [isToolRunning, setIsToolRunning] = useState(false);
  const [elapsedTime, setElapsedTime] = useState<number | null>(null);
  const [isOutputSchemaExpanded, setIsOutputSchemaExpanded] = useState(false);
  const [isMetaExpanded, setIsMetaExpanded] = useState(false);
  const [hasValidationErrors, setHasValidationErrors] = useState(false);
  const formRefs = useRef<Record<string, DynamicJsonFormRef | null>>({});
  const { toast } = useToast();
  const { copied, setCopied } = useCopy();
  const { copied: curlCopied, setCopied: setCurlCopied } = useCopy();
  const [toolRunStatuses, setToolRunStatuses] = useState<
    Map<number, "success" | "error" | "running">
  >(new Map());
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [toolRunDataMap, setToolRunDataMap] = useState<
    Map<number, ToolRunData>
  >(new Map());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogToolIndex, setDialogToolIndex] = useState<number | null>(null);

  const generateToolDefaultParams = useCallback(
    (tool: Tool): Record<string, unknown> => {
      const params = Object.entries(tool.inputSchema.properties ?? []).map(
        ([key, value]) => [
          key,
          generateDefaultValue(
            value as JsonSchemaType,
            key,
            tool.inputSchema as JsonSchemaType,
          ),
        ],
      );
      return Object.fromEntries(params);
    },
    [],
  );

  const runAllTools = useCallback(async () => {
    if (isRunningAll || tools.length === 0) return;
    setIsRunningAll(true);
    setToolRunStatuses(new Map());
    setToolRunDataMap(new Map());

    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      const defaultParams = generateToolDefaultParams(tool);

      setToolRunStatuses((prev) => {
        const next = new Map(prev);
        next.set(i, "running");
        return next;
      });

      const startTime = performance.now();
      const { success, result } = await callTool(tool.name, defaultParams);
      const elapsed = performance.now() - startTime;
      const status = success ? ("success" as const) : ("error" as const);

      setToolRunStatuses((prev) => {
        const next = new Map(prev);
        next.set(i, status);
        return next;
      });

      // Store run data for the dialog
      setToolRunDataMap((prev) => {
        const next = new Map(prev);
        next.set(i, {
          tool,
          params: defaultParams,
          result,
          status,
          elapsedTime: elapsed,
        });
        return next;
      });
    }

    setIsRunningAll(false);
  }, [isRunningAll, tools, generateToolDefaultParams, callTool]);

  // Function to check if any form has validation errors
  const checkValidationErrors = () => {
    const errors = Object.values(formRefs.current).some(
      (ref) => ref && !ref.validateJson().isValid,
    );
    setHasValidationErrors(errors);
    return errors;
  };

  useEffect(() => {
    const params = Object.entries(
      selectedTool?.inputSchema.properties ?? [],
    ).map(([key, value]) => [
      key,
      generateDefaultValue(
        value as JsonSchemaType,
        key,
        selectedTool?.inputSchema as JsonSchemaType,
      ),
    ]);
    setParams(Object.fromEntries(params));

    // Reset validation errors when switching tools
    setHasValidationErrors(false);

    // Clear form refs for the previous tool
    formRefs.current = {};
  }, [selectedTool]);

  /**
   * For n8n workflow servers, find the single .n8n file that best matches the
   * selected tool name.  We normalise both the tool name and the basename of
   * each file (strip extension → lowercase → collapse hyphens/underscores)
   * and check whether one contains the other.
   */
  const findMatchingN8nFile = (
    files: string[],
    toolName: string,
  ): string | undefined => {
    const normalise = (s: string) =>
      s.toLowerCase().replace(/[-_]/g, "").trim();
    const normTool = normalise(toolName);

    for (const filePath of files) {
      const baseName = filePath.split("/").pop() || "";
      const nameWithoutExt = baseName.replace(/\.n8n$/i, "");
      const normFile = normalise(nameWithoutExt);
      if (normTool.includes(normFile) || normFile.includes(normTool)) {
        return filePath;
      }
    }
    return undefined;
  };

  // Detect if the current connected server is an n8n workflow server
  const N8N_PREFIX = ["exec", "n8n-atom-cli", "mcp"];
  const serverArgs = (
    currentServerConfig as Record<string, unknown> | undefined
  )?.args as string[] | undefined;
  let isN8nServer =
    Array.isArray(serverArgs) &&
    serverArgs.length > N8N_PREFIX.length &&
    serverArgs.slice(0, N8N_PREFIX.length).every((a, i) => a === N8N_PREFIX[i]);
  let n8nFilePaths = isN8nServer ? serverArgs!.slice(N8N_PREFIX.length) : [];

  // Fallback: if currentServerConfig doesn't have n8n args (e.g. in VSCode
  // extension iframe with separate localStorage), check the loaded config
  // file servers for any server with the n8n arg pattern.
  if (!isN8nServer && loadedServers) {
    for (const serverConfig of Object.values(loadedServers)) {
      const sArgs = serverConfig?.args as string[] | undefined;
      if (
        Array.isArray(sArgs) &&
        sArgs.length > N8N_PREFIX.length &&
        sArgs
          .slice(0, N8N_PREFIX.length)
          .every((a: string, i: number) => a === N8N_PREFIX[i])
      ) {
        isN8nServer = true;
        n8nFilePaths = sArgs.slice(N8N_PREFIX.length);
        break;
      }
    }
  }

  /**
   * Open the matching .n8n file for a given tool.
   * First tries VSCode postMessage, falls back to server /open-config-file.
   */
  const handleOpenN8nFile = useCallback(
    async (filePath: string) => {
      // Attempt 1: Try VSCode postMessage
      const vscodeOpened = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(false);
        }, 2000);

        const handler = (event: MessageEvent) => {
          if (event.data && event.data.type === "openN8nFileResponse") {
            clearTimeout(timeout);
            window.removeEventListener("message", handler);
            resolve(!!event.data.success);
          }
        };

        window.addEventListener("message", handler);
        window.parent.postMessage({ type: "openN8nFile", filePath }, "*");
      });

      if (vscodeOpened) return;

      // Attempt 2: Fall back to server /open-config-file endpoint
      if (!config) return;
      try {
        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);
        const url = `${baseUrl}/open-config-file?path=${encodeURIComponent(filePath)}`;
        await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [header]: token ? `Bearer ${token}` : "",
          },
        });
      } catch (error) {
        console.error("[ToolsTab] Failed to open n8n file:", error);
      }
    },
    [config],
  );

  const generateCurlForTool = useCallback(
    (tool: Tool, toolParams: Record<string, unknown>) => {
      const proxyUrl = "http://localhost:6277";
      const rawServer = currentServerConfig || { type: "stdio" };
      const { env: _ignoredEnv, ...server } = rawServer as Record<
        string,
        unknown
      >;

      // For n8n workflow servers, only include the single relevant .n8n file
      const N8N_PREFIX = ["exec", "n8n-atom-cli", "mcp"];
      const serverArgs = server.args as string[] | undefined;
      if (
        Array.isArray(serverArgs) &&
        serverArgs.length > N8N_PREFIX.length &&
        serverArgs
          .slice(0, N8N_PREFIX.length)
          .every((a, i) => a === N8N_PREFIX[i])
      ) {
        const filePaths = serverArgs.slice(N8N_PREFIX.length);
        const matchedFile = findMatchingN8nFile(filePaths, tool.name);
        if (matchedFile) {
          server.args = [...N8N_PREFIX, matchedFile];
        }
      }

      const serverUrl = normalizeCredentialUrl(server.url || server.sseUrl);
      const requestBody: Record<string, unknown> = {
        toolName: tool.name,
        toolArgs: toolParams,
        server,
      };

      const effectiveCredentialsFolderPath =
        credentialsFolderPath ||
        localStorage.getItem("credentialsFolderPath") ||
        "./data";
      const enabledKeys =
        enabledCredentials && enabledCredentials.size > 0
          ? [...enabledCredentials]
          : readEnabledCredentialKeysFromStorage();

      if (serverUrl && effectiveCredentialsFolderPath) {
        requestBody.credentialsFolderPath = effectiveCredentialsFolderPath;
        requestBody.enabledCredentialKeys = enabledKeys;

        const matchingKey = enabledKeys.find(
          (key) =>
            normalizeCredentialUrl(rawCredentials?.[key]?.server_url) ===
            serverUrl,
        );
        const matchingCredential = matchingKey
          ? rawCredentials?.[matchingKey]
          : null;

        if (matchingKey && matchingCredential) {
          requestBody.credentialMeta = {
            folderPath: effectiveCredentialsFolderPath,
            sourceFile: matchingCredential._sourceFile || "credentials.json",
            credentialKey: matchingCredential._credentialKey || matchingKey,
          };
        }
      }
      console.log("[ToolsTab] Generated execute-tool cURL body", {
        bodyKeys: Object.keys(requestBody),
        serverUrl,
        credentialsFolderPath: requestBody.credentialsFolderPath,
        enabledCredentialKeys: requestBody.enabledCredentialKeys,
        credentialMeta: requestBody.credentialMeta,
      });

      return `curl -X POST ${proxyUrl}/execute-tool \\
  -H "Origin: http://localhost:6274" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(requestBody, null, 2)}'`;
    },
    [
      currentServerConfig,
      credentialsFolderPath,
      enabledCredentials,
      rawCredentials,
    ],
  );

  const generateCurlCommand = () => {
    if (!selectedTool) return "";
    return generateCurlForTool(selectedTool, params);
  };

  const handleCopyCurl = async () => {
    try {
      const curlCommand = generateCurlCommand();
      const result = await copyToClipboard(curlCommand);

      if (result.success) {
        setCurlCopied(true);
        toast({
          title: "Success",
          description: "cURL command copied to clipboard",
        });
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
  };

  return (
    <TabsContent value="tools">
      <div className="grid grid-cols-2 gap-4">
        <ListPane
          items={tools}
          listItems={listTools}
          clearItems={() => {
            clearTools();
            setSelectedTool(null);
          }}
          setSelectedItem={setSelectedTool}
          renderItem={(tool) => {
            const matchedFile = isN8nServer
              ? findMatchingN8nFile(n8nFilePaths, tool.name)
              : undefined;
            return (
              <div className="flex items-start gap-2">
                <div className="flex flex-col items-start flex-1 min-w-0">
                  <span className="flex-1">{tool.name}</span>
                  <span className="text-sm text-gray-500 text-left line-clamp-3">
                    {tool.description}
                  </span>
                </div>
                {isN8nServer && matchedFile && (
                  <button
                    className="mt-0.5 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors flex-shrink-0"
                    title={`Open ${matchedFile.split("/").pop()}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenN8nFile(matchedFile);
                    }}
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
            );
          }}
          title="Tools"
          buttonText={nextCursor ? "List More Tools" : "List Tools"}
          isButtonDisabled={!nextCursor && tools.length > 0}
          headerActions={
            <button
              name="run-all"
              aria-label="Run All Tools"
              title="Run All Tools"
              onClick={runAllTools}
              disabled={isRunningAll || tools.length === 0}
              className="p-2 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all duration-300 ease-in-out disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isRunningAll ? (
                <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
              ) : (
                <PlayCircle className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
          }
          itemStatus={toolRunStatuses}
          onStatusClick={(originalIndex) => {
            setDialogToolIndex(originalIndex);
            setDialogOpen(true);
          }}
        />

        <div className="bg-card border border-border rounded-lg shadow">
          <div className="p-4 border-b border-gray-200 dark:border-border">
            <h3 className="font-semibold">
              {selectedTool ? selectedTool.name : "Select a tool"}
            </h3>
          </div>
          <div className="p-4">
            {selectedTool ? (
              <div className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription className="break-all">
                      {error}
                    </AlertDescription>
                  </Alert>
                )}
                <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {selectedTool.description}
                </p>
                {Object.entries(selectedTool.inputSchema.properties ?? []).map(
                  ([key, value]) => {
                    const prop = normalizeUnionType(value as JsonSchemaType);
                    const inputSchema =
                      selectedTool.inputSchema as JsonSchemaType;
                    const required = isPropertyRequired(key, inputSchema);
                    return (
                      <div key={key}>
                        <div className="flex justify-between">
                          <Label
                            htmlFor={key}
                            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                          >
                            {key}
                            {required && (
                              <span className="text-red-500 ml-1">*</span>
                            )}
                          </Label>
                          {prop.nullable ? (
                            <div className="flex items-center space-x-2">
                              <Checkbox
                                id={key}
                                name={key}
                                checked={params[key] === null}
                                onCheckedChange={(checked: boolean) =>
                                  setParams({
                                    ...params,
                                    [key]: checked ? null : prop.default,
                                  })
                                }
                              />
                              <label
                                htmlFor={key}
                                className="text-sm font-medium text-gray-700 dark:text-gray-300"
                              >
                                null
                              </label>
                            </div>
                          ) : null}
                        </div>

                        <div
                          role="toolinputwrapper"
                          className={`${prop.nullable && params[key] === null ? "pointer-events-none opacity-50" : ""}`}
                        >
                          {prop.type === "boolean" ? (
                            <div className="flex items-center space-x-2 mt-2">
                              <Checkbox
                                id={key}
                                name={key}
                                checked={!!params[key]}
                                onCheckedChange={(checked: boolean) =>
                                  setParams({
                                    ...params,
                                    [key]: checked,
                                  })
                                }
                              />
                              <label
                                htmlFor={key}
                                className="text-sm font-medium text-gray-700 dark:text-gray-300"
                              >
                                {prop.description || "Toggle this option"}
                              </label>
                            </div>
                          ) : prop.type === "string" && prop.enum ? (
                            <Select
                              value={
                                params[key] === undefined
                                  ? ""
                                  : String(params[key])
                              }
                              onValueChange={(value) => {
                                if (value === "") {
                                  setParams({
                                    ...params,
                                    [key]: undefined,
                                  });
                                } else {
                                  setParams({
                                    ...params,
                                    [key]: value,
                                  });
                                }
                              }}
                            >
                              <SelectTrigger id={key} className="mt-1">
                                <SelectValue
                                  placeholder={
                                    prop.description || "Select an option"
                                  }
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {prop.enum.map((option) => (
                                  <SelectItem key={option} value={option}>
                                    {option}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : prop.type === "string" ? (
                            <Textarea
                              id={key}
                              name={key}
                              placeholder={prop.description}
                              value={
                                params[key] === undefined
                                  ? ""
                                  : String(params[key])
                              }
                              onChange={(e) => {
                                const value = e.target.value;
                                if (value === "") {
                                  // Field cleared - set to undefined
                                  setParams({
                                    ...params,
                                    [key]: undefined,
                                  });
                                } else {
                                  // Field has value - keep as string
                                  setParams({
                                    ...params,
                                    [key]: value,
                                  });
                                }
                              }}
                              className="mt-1"
                            />
                          ) : prop.type === "object" ||
                            prop.type === "array" ? (
                            <div className="mt-1">
                              <DynamicJsonForm
                                ref={(ref) => (formRefs.current[key] = ref)}
                                schema={{
                                  type: prop.type,
                                  properties: prop.properties,
                                  description: prop.description,
                                  items: prop.items,
                                }}
                                value={
                                  (params[key] as JsonValue) ??
                                  generateDefaultValue(prop)
                                }
                                onChange={(newValue: JsonValue) => {
                                  setParams({
                                    ...params,
                                    [key]: newValue,
                                  });
                                  // Check validation after a short delay to allow form to update
                                  setTimeout(checkValidationErrors, 100);
                                }}
                              />
                            </div>
                          ) : prop.type === "number" ||
                            prop.type === "integer" ? (
                            <Input
                              type="number"
                              id={key}
                              name={key}
                              placeholder={prop.description}
                              value={
                                params[key] === undefined
                                  ? ""
                                  : String(params[key])
                              }
                              onChange={(e) => {
                                const value = e.target.value;
                                if (value === "") {
                                  // Field cleared - set to undefined
                                  setParams({
                                    ...params,
                                    [key]: undefined,
                                  });
                                } else {
                                  // Field has value - try to convert to number, but store input either way
                                  const num = Number(value);
                                  if (!isNaN(num)) {
                                    setParams({
                                      ...params,
                                      [key]: num,
                                    });
                                  } else {
                                    // Store invalid input as string - let server validate
                                    setParams({
                                      ...params,
                                      [key]: value,
                                    });
                                  }
                                }
                              }}
                              className="mt-1"
                            />
                          ) : (
                            <div className="mt-1">
                              <DynamicJsonForm
                                ref={(ref) => (formRefs.current[key] = ref)}
                                schema={{
                                  type: prop.type,
                                  properties: prop.properties,
                                  description: prop.description,
                                  items: prop.items,
                                }}
                                value={params[key] as JsonValue}
                                onChange={(newValue: JsonValue) => {
                                  setParams({
                                    ...params,
                                    [key]: newValue,
                                  });
                                  // Check validation after a short delay to allow form to update
                                  setTimeout(checkValidationErrors, 100);
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  },
                )}
                {selectedTool.outputSchema && (
                  <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-semibold">Output Schema:</h4>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setIsOutputSchemaExpanded(!isOutputSchemaExpanded)
                        }
                        className="h-6 px-2"
                      >
                        {isOutputSchemaExpanded ? (
                          <>
                            <ChevronUp className="h-3 w-3 mr-1" />
                            Collapse
                          </>
                        ) : (
                          <>
                            <ChevronDown className="h-3 w-3 mr-1" />
                            Expand
                          </>
                        )}
                      </Button>
                    </div>
                    <div
                      className={`transition-all ${
                        isOutputSchemaExpanded
                          ? ""
                          : "max-h-[8rem] overflow-y-auto"
                      }`}
                    >
                      <JsonView data={selectedTool.outputSchema} />
                    </div>
                  </div>
                )}
                {selectedTool &&
                  hasMeta(selectedTool) &&
                  selectedTool._meta && (
                    <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-sm font-semibold">Meta:</h4>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setIsMetaExpanded(!isMetaExpanded)}
                          className="h-6 px-2"
                        >
                          {isMetaExpanded ? (
                            <>
                              <ChevronUp className="h-3 w-3 mr-1" />
                              Collapse
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-3 w-3 mr-1" />
                              Expand
                            </>
                          )}
                        </Button>
                      </div>
                      <div
                        className={`transition-all ${
                          isMetaExpanded ? "" : "max-h-[8rem] overflow-y-auto"
                        }`}
                      >
                        <JsonView data={selectedTool._meta} />
                      </div>
                    </div>
                  )}
                <div className="flex gap-2">
                  <Button
                    onClick={async () => {
                      // Validate JSON inputs before calling tool
                      if (checkValidationErrors()) return;

                      const toolIndex = tools.indexOf(selectedTool);

                      try {
                        setIsToolRunning(true);
                        setElapsedTime(null);

                        // Show running status in list
                        if (toolIndex !== -1) {
                          setToolRunStatuses((prev) => {
                            const next = new Map(prev);
                            next.set(toolIndex, "running");
                            return next;
                          });
                        }

                        const startTime = performance.now();
                        const { success, result } = await callTool(
                          selectedTool.name,
                          params,
                        );
                        const elapsed = performance.now() - startTime;
                        setElapsedTime(elapsed);
                        const status = success
                          ? ("success" as const)
                          : ("error" as const);

                        // Show success/error status in list
                        if (toolIndex !== -1) {
                          setToolRunStatuses((prev) => {
                            const next = new Map(prev);
                            next.set(toolIndex, status);
                            return next;
                          });

                          // Store run data for the dialog
                          setToolRunDataMap((prev) => {
                            const next = new Map(prev);
                            next.set(toolIndex, {
                              tool: selectedTool,
                              params: { ...params },
                              result,
                              status,
                              elapsedTime: elapsed,
                            });
                            return next;
                          });
                        }
                      } catch {
                        setElapsedTime(null);
                        // Show error status in list
                        if (toolIndex !== -1) {
                          setToolRunStatuses((prev) => {
                            const next = new Map(prev);
                            next.set(toolIndex, "error");
                            return next;
                          });

                          setToolRunDataMap((prev) => {
                            const next = new Map(prev);
                            next.set(toolIndex, {
                              tool: selectedTool,
                              params: { ...params },
                              result: null,
                              status: "error",
                              elapsedTime: null,
                            });
                            return next;
                          });
                        }
                      } finally {
                        setIsToolRunning(false);
                      }
                    }}
                    disabled={isToolRunning || hasValidationErrors}
                  >
                    {isToolRunning ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Running...
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4 mr-2" />
                        Run Tool
                      </>
                    )}
                  </Button>
                  <Button
                    onClick={async () => {
                      try {
                        const result = await copyToClipboard(
                          JSON.stringify(params, null, 2),
                        );

                        if (result.success) {
                          setCopied(true);
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
                            error instanceof Error
                              ? error.message
                              : String(error),
                          ),
                          variant: "destructive",
                        });
                      }
                    }}
                  >
                    {copied ? (
                      <CheckCheck className="h-4 w-4 mr-2 dark:text-green-700 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4 mr-2" />
                    )}
                    Copy Input
                  </Button>
                  <Button onClick={handleCopyCurl} variant="outline">
                    {curlCopied ? (
                      <CheckCheck className="h-4 w-4 mr-2 dark:text-green-700 text-green-600" />
                    ) : (
                      <Terminal className="h-4 w-4 mr-2" />
                    )}
                    Copy cURL
                  </Button>
                </div>
                <ToolResults
                  toolResult={toolResult}
                  selectedTool={selectedTool}
                  resourceContent={resourceContent}
                  onReadResource={onReadResource}
                  elapsedTime={elapsedTime}
                />
              </div>
            ) : (
              <Alert>
                <AlertDescription>
                  Select a tool from the list to view its details and run it
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>
      </div>
      <ToolRunDetailDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        runData={
          dialogToolIndex !== null
            ? (toolRunDataMap.get(dialogToolIndex) ?? null)
            : null
        }
        onRunTool={async (tool, runParams) => {
          const toolIndex = tools.indexOf(tool);

          if (toolIndex !== -1) {
            setToolRunStatuses((prev) => {
              const next = new Map(prev);
              next.set(toolIndex, "running");
              return next;
            });
          }

          const startTime = performance.now();
          const { success, result } = await callTool(tool.name, runParams);
          const elapsed = performance.now() - startTime;
          const status = success ? ("success" as const) : ("error" as const);

          if (toolIndex !== -1) {
            setToolRunStatuses((prev) => {
              const next = new Map(prev);
              next.set(toolIndex, status);
              return next;
            });

            setToolRunDataMap((prev) => {
              const next = new Map(prev);
              next.set(toolIndex, {
                tool,
                params: runParams,
                result,
                status,
                elapsedTime: elapsed,
              });
              return next;
            });
          }
        }}
        generateCurlForTool={generateCurlForTool}
        resourceContent={resourceContent}
        onReadResource={onReadResource}
      />
    </TabsContent>
  );
};

export default ToolsTab;
