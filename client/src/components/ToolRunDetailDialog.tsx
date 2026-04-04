import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Send,
  Loader2,
  Copy,
  CheckCheck,
  Terminal,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import {
  CompatibilityCallToolResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import JsonView from "./JsonView";
import ToolResults from "./ToolResults";
import useCopy from "@/lib/hooks/useCopy";
import { useToast } from "@/lib/hooks/useToast";
import {
  copyToClipboard,
  getClipboardErrorMessage,
} from "@/utils/clipboardUtils";

export interface ToolRunData {
  tool: Tool;
  params: Record<string, unknown>;
  result: CompatibilityCallToolResult | null;
  status: "success" | "error" | "running";
  elapsedTime: number | null;
}

interface ToolRunDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runData: ToolRunData | null;
  onRunTool: (tool: Tool, params: Record<string, unknown>) => Promise<void>;
  generateCurlForTool: (tool: Tool, params: Record<string, unknown>) => string;
  resourceContent: Record<string, string>;
  onReadResource?: (uri: string) => void;
}

const ToolRunDetailDialog = ({
  open,
  onOpenChange,
  runData,
  onRunTool,
  generateCurlForTool,
  resourceContent,
  onReadResource,
}: ToolRunDetailDialogProps) => {
  const [isRunning, setIsRunning] = useState(false);
  const { copied: inputCopied, setCopied: setInputCopied } = useCopy();
  const { copied: curlCopied, setCopied: setCurlCopied } = useCopy();
  const { toast } = useToast();

  if (!runData) return null;

  const { tool, params, result, status, elapsedTime } = runData;

  const handleRunTool = async () => {
    try {
      setIsRunning(true);
      await onRunTool(tool, params);
    } finally {
      setIsRunning(false);
    }
  };

  const handleCopyInput = async () => {
    try {
      const res = await copyToClipboard(JSON.stringify(params, null, 2));
      if (res.success) {
        setInputCopied(true);
      } else {
        toast({
          title: "Error",
          description: getClipboardErrorMessage(res.error || "Unknown error"),
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

  const handleCopyCurl = async () => {
    try {
      const curlCommand = generateCurlForTool(tool, params);
      const res = await copyToClipboard(curlCommand);
      if (res.success) {
        setCurlCopied(true);
        toast({
          title: "Success",
          description: "cURL command copied to clipboard",
        });
      } else {
        toast({
          title: "Error",
          description: getClipboardErrorMessage(res.error || "Unknown error"),
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {status === "success" && (
              <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0" />
            )}
            {status === "error" && (
              <XCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
            )}
            {status === "running" && (
              <Loader2 className="w-5 h-5 text-blue-500 animate-spin flex-shrink-0" />
            )}
            {tool.name}
          </DialogTitle>
          {tool.description && (
            <DialogDescription className="text-sm text-gray-500 dark:text-gray-400 whitespace-pre-wrap">
              {tool.description}
            </DialogDescription>
          )}
        </DialogHeader>

        {/* Input Parameters */}
        <div>
          <h4 className="font-semibold text-sm mb-2">Input Parameters:</h4>
          <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg max-h-48 overflow-y-auto">
            <JsonView data={params} />
          </div>
        </div>

        {/* Output / Tool Result */}
        <div>
          <ToolResults
            toolResult={result}
            selectedTool={tool}
            resourceContent={resourceContent}
            onReadResource={onReadResource}
            elapsedTime={elapsedTime}
          />
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 flex-wrap pt-2 border-t border-border">
          <Button onClick={handleRunTool} disabled={isRunning} size="sm">
            {isRunning ? (
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
          <Button onClick={handleCopyInput} variant="outline" size="sm">
            {inputCopied ? (
              <CheckCheck className="h-4 w-4 mr-2 dark:text-green-700 text-green-600" />
            ) : (
              <Copy className="h-4 w-4 mr-2" />
            )}
            Copy Input
          </Button>
          <Button onClick={handleCopyCurl} variant="outline" size="sm">
            {curlCopied ? (
              <CheckCheck className="h-4 w-4 mr-2 dark:text-green-700 text-green-600" />
            ) : (
              <Terminal className="h-4 w-4 mr-2" />
            )}
            Copy cURL
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ToolRunDetailDialog;
