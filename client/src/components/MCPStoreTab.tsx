import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  Play
} from "lucide-react";
import { useToast } from "../lib/hooks/useToast";
import { InspectorConfig } from "@/lib/configurationTypes";
import { getMCPProxyAddress, getMCPProxyAuthToken } from "@/utils/configUtils";

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
}

interface MCPSourceResponse {
  mcpServers: Record<string, MCPServer>;
}

interface MCPStoreTabProps {
  config: InspectorConfig;
  currentServers?: Record<string, any>;
  onServersChange?: (servers: Record<string, any>) => void;
  onTestConnection?: (serverConfig: any) => void;
}

const MCPStoreTab = ({ config, currentServers = {}, onServersChange, onTestConnection }: MCPStoreTabProps) => {
  const [sources, setSources] = useState<MCPSource[]>([
    {
      name: "Default MCP Store",
      url: "https://gist.github.com/KhanhPham2411/fe8161eea89fb563915492b8b2de4ef9",
      enabled: true
    }
  ]);
  const [availableServers, setAvailableServers] = useState<MCPServer[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showSourceConfig, setShowSourceConfig] = useState(false);
  const [newSource, setNewSource] = useState({ name: "", url: "", enabled: true });
  const [selectedSource, setSelectedSource] = useState<string>("Default MCP Store");
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
  }, [sources]);

  // Fetch MCP servers from all enabled sources
  const fetchMCPServers = useCallback(async () => {
    setIsLoading(true);
    try {
      const enabledSources = sources.filter(source => source.enabled);
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
            throw new Error(`Failed to fetch from ${source.name}: ${response.statusText}`);
          }
          
          const data: MCPSourceResponse = await response.json();
          const servers = Object.entries(data.mcpServers).map(([name, config]) => ({
            ...config,
            name,
            source: source.name
          }));
          
          allServers.push(...servers);
        } catch (error) {
          console.error(`Error fetching from ${source.name}:`, error);
          toast({
            title: "Error",
            description: `Failed to fetch from ${source.name}: ${error instanceof Error ? error.message : String(error)}`,
            variant: "destructive"
          });
        }
      }

      setAvailableServers(allServers);
    } catch (error) {
      console.error("Error fetching MCP servers:", error);
      toast({
        title: "Error",
        description: "Failed to fetch MCP servers",
        variant: "destructive"
      });
    } finally {
      setIsLoading(false);
    }
  }, [sources, toast]);

  // Load servers on component mount and when sources change
  useEffect(() => {
    fetchMCPServers();
  }, [fetchMCPServers]);

  const handleAddSource = () => {
    if (!newSource.name || !newSource.url) {
      toast({
        title: "Error",
        description: "Please provide both name and URL for the source",
        variant: "destructive"
      });
      return;
    }

    setSources(prev => [...prev, newSource]);
    setNewSource({ name: "", url: "", enabled: true });
    setShowSourceConfig(false);
    toast({
      title: "Success",
      description: `Added source: ${newSource.name}`
    });
  };

  const handleRemoveSource = (sourceName: string) => {
    setSources(prev => prev.filter(source => source.name !== sourceName));
    toast({
      title: "Success",
      description: `Removed source: ${sourceName}`
    });
  };

  const handleToggleSource = (sourceName: string) => {
    setSources(prev => 
      prev.map(source => 
        source.name === sourceName 
          ? { ...source, enabled: !source.enabled }
          : source
      )
    );
  };

  // Check if a server is already installed
  const isServerInstalled = (server: MCPServer): boolean => {
    return Object.values(currentServers).some((existingServer: any) => {
      // Check if command and args match
      if (existingServer.command === server.command) {
        const existingArgs = Array.isArray(existingServer.args) ? existingServer.args : [];
        const serverArgs = Array.isArray(server.args) ? server.args : [];
        return JSON.stringify(existingArgs) === JSON.stringify(serverArgs);
      }
      return false;
    });
  };

  const handleInstallServer = async (server: MCPServer) => {
    try {
      // Generate the server configuration
      const serverConfig = {
        command: server.command,
        args: server.args,
        env: server.env,
        disabled: server.disabled,
        autoApprove: server.autoApprove
      };

      // Generate a unique server name (use the store name or create one)
      const serverName = server.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const finalServerName = Object.keys(currentServers).includes(serverName) 
        ? `${serverName}-${Date.now()}` 
        : serverName;

      // Add the new server to current configuration
      const updatedServers = {
        ...currentServers,
        [finalServerName]: serverConfig
      };
      
      // Update the MCP configuration file via API
      const baseUrl = getMCPProxyAddress(config);
      const { token, header } = getMCPProxyAuthToken(config);
      const response = await fetch(`${baseUrl}/update-mcp-config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [header]: token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({ servers: updatedServers })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      await response.json();
      
      // Refresh the current servers
      if (onServersChange) {
        onServersChange(updatedServers);
      }
      
      toast({
        title: "Server Installed",
        description: `${server.name} has been added to your MCP configuration file as "${finalServerName}".`
      });
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to install server: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive"
      });
    }
  };

  const handleTestConnection = (server: MCPServer) => {
    const serverConfig = {
      command: server.command,
      args: server.args,
      env: server.env,
      disabled: server.disabled,
      autoApprove: server.autoApprove
    };

    if (onTestConnection) {
      onTestConnection(serverConfig);
    } else {
      toast({
        title: "Test Connection",
        description: `Testing connection to ${server.name}...`,
      });
    }
  };

  const handleUninstallServer = async (server: MCPServer) => {
    try {
      // Find the server name in current configuration
      const serverName = Object.keys(currentServers).find(name => {
        const existingServer = currentServers[name];
        if (existingServer.command === server.command) {
          const existingArgs = Array.isArray(existingServer.args) ? existingServer.args : [];
          const serverArgs = Array.isArray(server.args) ? server.args : [];
          return JSON.stringify(existingArgs) === JSON.stringify(serverArgs);
        }
        return false;
      });

      if (serverName) {
        // Generate configuration without this server
        const updatedServers = { ...currentServers };
        delete updatedServers[serverName];
        
        // Update the MCP configuration file via API
        const baseUrl = getMCPProxyAddress(config);
        const { token, header } = getMCPProxyAuthToken(config);
        const response = await fetch(`${baseUrl}/update-mcp-config`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [header]: token ? `Bearer ${token}` : "",
          },
          body: JSON.stringify({ servers: updatedServers })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
        }

        await response.json();
        
        // Refresh the current servers
        if (onServersChange) {
          onServersChange(updatedServers);
        }
        
        toast({
          title: "Server Uninstalled",
          description: `${server.name} (${serverName}) has been removed from your MCP configuration file.`
        });
      } else {
        toast({
          title: "Server Not Found",
          description: `Could not find ${server.name} in current configuration.`,
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to uninstall server: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive"
      });
    }
  };

  const filteredServers = availableServers.filter(server =>
    server.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (server.description && server.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="w-full p-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Store className="w-6 h-6" />
            MCP Store
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

      {/* Source Selection */}
      <div className="mb-6">
        <Label className="text-sm font-medium mb-2 block">Package Source</Label>
        <div className="flex items-center gap-2">
          <select
            value={selectedSource}
            onChange={(e) => setSelectedSource(e.target.value)}
            className="flex-1 px-3 py-2 border border-input bg-background rounded-md text-sm"
          >
            {sources.filter(s => s.enabled).map(source => (
              <option key={source.name} value={source.name}>
                {source.name}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowSourceConfig(true)}
          >
            <Settings className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Servers Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredServers.map((server, index) => (
          <Card key={`${server.name}-${index}`} className="hover:shadow-md transition-shadow">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <Package className="w-5 h-5 text-primary" />
                  <CardTitle className="text-lg">{server.name}</CardTitle>
                </div>
                <Badge variant="secondary" className="text-xs">
                  {(server as any).source || "Unknown"}
                </Badge>
              </div>
              {server.description && (
                <CardDescription className="text-sm">
                  {server.description}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>Command:</span>
                  <code className="bg-muted px-2 py-1 rounded text-xs">
                    {server.command} {server.args.join(" ")}
                  </code>
                </div>
                
                {server.version && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Version:</span>
                    <span>{server.version}</span>
                  </div>
                )}
                
                {server.author && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Author:</span>
                    <span>{server.author}</span>
                  </div>
                )}
                
                {server.license && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">License:</span>
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
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Uninstall
                    </Button>
                  ) : (
                    <Button
                      onClick={() => handleInstallServer(server)}
                      className="flex-1"
                      size="sm"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Install
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTestConnection(server)}
                    title="Test connection to this server"
                  >
                    <Play className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const config = {
                        command: server.command,
                        args: server.args,
                        env: server.env,
                        disabled: server.disabled,
                        autoApprove: server.autoApprove
                      };
                      console.log("Server config:", config);
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

      {filteredServers.length === 0 && !isLoading && (
        <div className="text-center py-12">
          <Package className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">No servers found</h3>
          <p className="text-muted-foreground">
            {searchQuery ? "Try adjusting your search terms" : "No MCP servers available from configured sources"}
          </p>
        </div>
      )}

      {/* Source Configuration Dialog */}
      <Dialog open={showSourceConfig} onOpenChange={setShowSourceConfig}>
        <DialogContent className="max-w-4xl w-full">
          <DialogHeader>
            <DialogTitle>Configure MCP Sources</DialogTitle>
            <DialogDescription>
              Add and manage sources for MCP servers. Sources should provide JSON files with mcpServers configuration.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            {/* Existing Sources */}
            <div>
              <Label className="text-sm font-medium mb-2 block">Current Sources</Label>
              <div className="space-y-2">
                {sources.map((source, index) => (
                  <div key={index} className="flex items-start gap-3 p-4 border rounded-lg">
                    <div className="flex-shrink-0 pt-1">
                      <Switch
                        checked={source.enabled}
                        onCheckedChange={() => handleToggleSource(source.name)}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium mb-1">{source.name}</div>
                      <div className="text-sm text-muted-foreground break-all">{source.url}</div>
                    </div>
                    <div className="flex-shrink-0 flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.open(source.url, '_blank')}
                        title="Open source URL"
                      >
                        <GotoIcon className="w-4 h-4" />
                      </Button>
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

            {/* Add New Source */}
            <div className="border-t pt-4">
              <Label className="text-sm font-medium mb-2 block">Add New Source</Label>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="source-name">Name</Label>
                  <Input
                    id="source-name"
                    placeholder="e.g., My MCP Store"
                    value={newSource.name}
                    onChange={(e) => setNewSource(prev => ({ ...prev, name: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="source-url">URL</Label>
                  <Input
                    id="source-url"
                    placeholder="https://example.com/mcp-servers.json"
                    value={newSource.url}
                    onChange={(e) => setNewSource(prev => ({ ...prev, url: e.target.value }))}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={newSource.enabled}
                    onCheckedChange={(checked) => setNewSource(prev => ({ ...prev, enabled: checked }))}
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
    </div>
  );
};

export default MCPStoreTab;
