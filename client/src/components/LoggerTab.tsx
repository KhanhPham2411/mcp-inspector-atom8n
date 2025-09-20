import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  Loader2
} from "lucide-react";
import { useToast } from "../lib/hooks/useToast";
import { getMCPProxyAddress, getMCPProxyAuthToken } from "@/utils/configUtils";
import { InspectorConfig } from "@/lib/configurationTypes";

interface LogFile {
  name: string;
  size?: number;
  lastModified?: string;
}

interface LogContent {
  content: string;
  pagination: {
    page: number;
    limit: number;
    totalLines: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  logFile: string;
}

interface LogLevel {
  level: 'info' | 'warn' | 'error' | 'debug';
  label: string;
  icon: React.ReactNode;
  color: string;
}

const LOG_LEVELS: LogLevel[] = [
  { level: 'info', label: 'Info', icon: <Info className="w-4 h-4" />, color: 'text-blue-600' },
  { level: 'warn', label: 'Warning', icon: <AlertTriangle className="w-4 h-4" />, color: 'text-yellow-600' },
  { level: 'error', label: 'Error', icon: <AlertCircle className="w-4 h-4" />, color: 'text-red-600' },
  { level: 'debug', label: 'Debug', icon: <Bug className="w-4 h-4" />, color: 'text-gray-600' }
];

const LoggerTab = ({ config }: { config: InspectorConfig }) => {
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [logContent, setLogContent] = useState<LogContent | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showTestDialog, setShowTestDialog] = useState(false);
  const [testLevel, setTestLevel] = useState<'info' | 'warn' | 'error' | 'debug'>('info');
  const [testMessage, setTestMessage] = useState('Test log message');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const { toast } = useToast();

  // Fetch available log files
  const fetchLogFiles = useCallback(async () => {
    try {
      const proxyAddress = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      
      const response = await fetch(`${proxyAddress}/logs`, {
        headers: {
          [header]: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch log files: ${response.statusText}`);
      }

      const data = await response.json();
      setLogFiles(data.files.map((file: string) => ({ name: file })));
      
      // Auto-select the first file if none selected
      if (!selectedFile && data.files.length > 0) {
        setSelectedFile(data.files[0]);
      }
    } catch (error) {
      console.error('Error fetching log files:', error);
      toast({
        title: "Error",
        description: `Failed to fetch log files: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: "destructive"
      });
    }
  }, [selectedFile, toast]);

  // Fetch log content
  const fetchLogContent = useCallback(async (filename: string, page: number = 1, limit: number = 100) => {
    if (!filename) return;

    setIsLoading(true);
    try {
      const proxyAddress = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      
      const endpoint = filename === 'current' ? '/logs/current' : `/logs/${filename}`;
      const response = await fetch(`${proxyAddress}${endpoint}?page=${page}&limit=${limit}`, {
        headers: {
          [header]: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch log content: ${response.statusText}`);
      }

      const data = await response.json();
      setLogContent(data);
      setCurrentPage(page);
    } catch (error) {
      console.error('Error fetching log content:', error);
      toast({
        title: "Error",
        description: `Failed to fetch log content: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: "destructive"
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  // Write test log
  const writeTestLog = useCallback(async () => {
    try {
      const proxyAddress = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      
      const response = await fetch(`${proxyAddress}/logs/test`, {
        method: 'POST',
        headers: {
          [header]: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          level: testLevel,
          message: testMessage
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to write test log: ${response.statusText}`);
      }

      toast({
        title: "Success",
        description: `Test log written with level: ${testLevel}`
      });

      // Refresh current log content
      if (selectedFile) {
        await fetchLogContent(selectedFile, currentPage, pageSize);
      }
    } catch (error) {
      console.error('Error writing test log:', error);
      toast({
        title: "Error",
        description: `Failed to write test log: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: "destructive"
      });
    }
  }, [testLevel, testMessage, selectedFile, currentPage, pageSize, fetchLogContent, toast]);

  // Clean up old logs
  const cleanupLogs = useCallback(async (daysToKeep: number = 7) => {
    try {
      const proxyAddress = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      
      const response = await fetch(`${proxyAddress}/logs/cleanup?days=${daysToKeep}`, {
        method: 'DELETE',
        headers: {
          [header]: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to cleanup logs: ${response.statusText}`);
      }

      toast({
        title: "Success",
        description: `Cleaned up log files older than ${daysToKeep} days`
      });

      // Refresh log files
      await fetchLogFiles();
    } catch (error) {
      console.error('Error cleaning up logs:', error);
      toast({
        title: "Error",
        description: `Failed to cleanup logs: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: "destructive"
      });
    }
  }, [fetchLogFiles, toast]);

  // Filter log content based on search query
  const filteredContent = logContent?.content
    ? logContent.content
        .split('\n')
        .filter(line => 
          searchQuery === '' || 
          line.toLowerCase().includes(searchQuery.toLowerCase())
        )
        .join('\n')
    : '';

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
    <div className="w-full p-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6" />
            Server Logs
          </h1>
          <p className="text-muted-foreground">
            View and manage server log files
          </p>
        </div>
        <div className="flex items-center gap-2">
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
                {selectedFile === 'current' ? 'Current Log' : selectedFile}
              </CardTitle>
              <CardDescription>
                {logContent?.pagination && (
                  <>
                    Page {logContent.pagination.page} of {logContent.pagination.totalPages} 
                    ({logContent.pagination.totalLines} total lines)
                  </>
                )}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={pageSize.toString()} onValueChange={(value) => setPageSize(parseInt(value))}>
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
                onClick={() => fetchLogContent(selectedFile, currentPage - 1, pageSize)}
                disabled={!logContent?.pagination?.hasPrev || isLoading}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchLogContent(selectedFile, currentPage + 1, pageSize)}
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
                {filteredContent || 'No log content available'}
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
              <Select value={testLevel} onValueChange={(value: any) => setTestLevel(value)}>
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
              <Button variant="outline" onClick={() => setShowTestDialog(false)}>
                Cancel
              </Button>
              <Button onClick={writeTestLog}>
                Write Log
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default LoggerTab;
