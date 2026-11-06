import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText,
  Trash2,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  Play,
  AlertCircle,
  Info,
  AlertTriangle,
  Bug,
  Loader2,
  FolderOpen,
} from "lucide-react";
import { useToast } from "../lib/hooks/useToast";
import { InspectorConfig } from "@/lib/configurationTypes";
import { createServerLogUtils, LogFile, LogContent } from "@/utils/logUtils";

interface LogLevelDisplay {
  level: "info" | "warn" | "error" | "debug";
  label: string;
  icon: React.ReactNode;
  color: string;
}

const LOG_LEVELS: LogLevelDisplay[] = [
  {
    level: "info",
    label: "Info",
    icon: <Info className="w-4 h-4" />,
    color: "text-blue-600",
  },
  {
    level: "warn",
    label: "Warning",
    icon: <AlertTriangle className="w-4 h-4" />,
    color: "text-yellow-600",
  },
  {
    level: "error",
    label: "Error",
    icon: <AlertCircle className="w-4 h-4" />,
    color: "text-red-600",
  },
  {
    level: "debug",
    label: "Debug",
    icon: <Bug className="w-4 h-4" />,
    color: "text-gray-600",
  },
];

const LoggerTab = ({ config }: { config: InspectorConfig }) => {
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [logContent, setLogContent] = useState<LogContent | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showTestDialog, setShowTestDialog] = useState(false);
  const [testLevel, setTestLevel] = useState<
    "info" | "warn" | "error" | "debug"
  >("info");
  const [testMessage, setTestMessage] = useState("Test log message");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const { toast } = useToast();

  // Fetch available log files
  const fetchLogFiles = useCallback(async () => {
    try {
      const logUtils = createServerLogUtils(config);
      const data = await logUtils.getLogFiles();

      setLogFiles(data.files.map((file: string) => ({ name: file })));

      // Auto-select the first file if none selected
      if (!selectedFile && data.files.length > 0) {
        setSelectedFile(data.files[0]);
      }
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to fetch log files: ${error instanceof Error ? error.message : "Unknown error"}`,
        variant: "destructive",
      });
    }
  }, [selectedFile, toast, config]);

  // Fetch log content
  const fetchLogContent = useCallback(
    async (filename: string, page: number = 1, limit: number = 100) => {
      if (!filename) return;

      setIsLoading(true);
      try {
        const logUtils = createServerLogUtils(config);
        const data =
          filename === "current"
            ? await logUtils.getCurrentLogContent(page, limit)
            : await logUtils.getLogFileContent(filename, page, limit);

        setLogContent(data);
        setCurrentPage(page);
      } catch (error) {
        toast({
          title: "Error",
          description: `Failed to fetch log content: ${error instanceof Error ? error.message : "Unknown error"}`,
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    },
    [toast, config],
  );

  // Write test log
  const writeTestLog = useCallback(async () => {
    try {
      const logUtils = createServerLogUtils(config);
      await logUtils.writeLog({
        level: testLevel,
        message: testMessage,
      });

      toast({
        title: "Success",
        description: `Test log written with level: ${testLevel}`,
      });

      // Refresh current log content
      if (selectedFile) {
        await fetchLogContent(selectedFile, currentPage, pageSize);
      }
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to write test log: ${error instanceof Error ? error.message : "Unknown error"}`,
        variant: "destructive",
      });
    }
  }, [
    testLevel,
    testMessage,
    selectedFile,
    currentPage,
    pageSize,
    fetchLogContent,
    toast,
    config,
  ]);

  // Open log folder in OS file manager
  const openLogFolder = useCallback(async () => {
    try {
      const logUtils = createServerLogUtils(config);
      await logUtils.openLogFolder();

      toast({
        title: "Success",
        description: "Log folder opened in file manager",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to open log folder: ${error instanceof Error ? error.message : "Unknown error"}`,
        variant: "destructive",
      });
    }
  }, [toast, config]);

  // Clean up old logs
  const cleanupLogs = useCallback(
    async (daysToKeep: number = 7) => {
      try {
        const logUtils = createServerLogUtils(config);
        await logUtils.cleanupLogs(daysToKeep);

        toast({
          title: "Success",
          description: `Cleaned up log files older than ${daysToKeep} days`,
        });

        // Refresh log files
        await fetchLogFiles();
      } catch (error) {
        toast({
          title: "Error",
          description: `Failed to cleanup logs: ${error instanceof Error ? error.message : "Unknown error"}`,
          variant: "destructive",
        });
      }
    },
    [fetchLogFiles, toast, config],
  );

  // Filter log content based on search query
  const filteredContent = logContent?.content
    ? logContent.content
        .split("\n")
        .filter(
          (line) =>
            searchQuery === "" ||
            line.toLowerCase().includes(searchQuery.toLowerCase()),
        )
        .join("\n")
    : "";

  // Load log files on component mount
  useEffect(() => {
    fetchLogFiles();
  }, [fetchLogFiles]);

  // Load log content when selected file changes
  useEffect(() => {
    if (selectedFile) {
      fetchLogContent(selectedFile, 1, pageSize);
    }
  }, [selectedFile, fetchLogContent, pageSize]);

  return (
    <div className="w-full p-2 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6 shrink-0" />
            Server Logs
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            View and manage server log files
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowTestDialog(true)}
            className="flex items-center gap-2"
          >
            <Play className="w-4 h-4" />
            Test Log
          </Button>
          <Button
            variant="outline"
            onClick={openLogFolder}
            className="flex items-center gap-2"
          >
            <FolderOpen className="w-4 h-4" />
            Open Log
          </Button>
          <Button
            variant="outline"
            onClick={() => cleanupLogs(7)}
            className="flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Cleanup
          </Button>
          <Button
            variant="outline"
            onClick={fetchLogFiles}
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

      {/* File Selection */}
      <div className="mb-6">
        <Label htmlFor="log-file-select" className="text-sm font-medium">
          Select Log File
        </Label>
        <Select value={selectedFile} onValueChange={setSelectedFile}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a log file" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">Current Log (Today)</SelectItem>
            {logFiles.map((file) => (
              <SelectItem key={file.name} value={file.name}>
                {file.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Search */}
      <div className="mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Search log content..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Log Content */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-5 h-5" />
                {selectedFile === "current" ? "Current Log" : selectedFile}
              </CardTitle>
              <CardDescription>
                {logContent?.pagination && (
                  <>
                    Page {logContent.pagination.page} of{" "}
                    {logContent.pagination.totalPages}(
                    {logContent.pagination.totalLines} total lines)
                  </>
                )}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={pageSize.toString()}
                onValueChange={(value) => setPageSize(parseInt(value))}
              >
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                  <SelectItem value="200">200</SelectItem>
                  <SelectItem value="500">500</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  fetchLogContent(selectedFile, currentPage - 1, pageSize)
                }
                disabled={!logContent?.pagination?.hasPrev || isLoading}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  fetchLogContent(selectedFile, currentPage + 1, pageSize)
                }
                disabled={!logContent?.pagination?.hasNext || isLoading}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="w-6 h-6 animate-spin mr-2" />
              Loading log content...
            </div>
          ) : (
            <div className="bg-gray-900 text-green-400 p-4 rounded-lg font-mono text-sm overflow-auto max-h-96">
              <pre className="whitespace-pre-wrap">
                {filteredContent || "No log content available"}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Test Log Dialog */}
      <Dialog open={showTestDialog} onOpenChange={setShowTestDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Write Test Log</DialogTitle>
            <DialogDescription>
              Write a test message to the server log with the specified level.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="test-level">Log Level</Label>
              <Select
                value={testLevel}
                onValueChange={(value: any) => setTestLevel(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOG_LEVELS.map((level) => (
                    <SelectItem key={level.level} value={level.level}>
                      <div className="flex items-center gap-2">
                        {level.icon}
                        {level.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="test-message">Message</Label>
              <Input
                id="test-message"
                value={testMessage}
                onChange={(e) => setTestMessage(e.target.value)}
                placeholder="Enter test message..."
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowTestDialog(false)}
              >
                Cancel
              </Button>
              <Button onClick={writeTestLog}>Write Log</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default LoggerTab;
