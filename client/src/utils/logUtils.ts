import { InspectorConfig } from "@/lib/configurationTypes";
import { getMCPProxyAddress, getMCPProxyAuthToken } from "@/utils/configUtils";

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  level: LogLevel;
  message: string;
  metadata?: Record<string, any>;
}

export interface LogFile {
  name: string;
  size?: number;
  lastModified?: string;
}

export interface LogContent {
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

export interface LogFilesResponse {
  success: boolean;
  files: string[];
  count: number;
  logsDirectory: string;
}

export interface LogTestResponse {
  success: boolean;
  message: string;
  level: LogLevel;
  logFile: string;
}

export interface LogCleanupResponse {
  success: boolean;
  message: string;
  daysToKeep: number;
}

/**
 * Utility class for server logging operations
 */
export class ServerLogUtils {
  private config: InspectorConfig;

  constructor(config: InspectorConfig) {
    this.config = config;
  }

  /**
   * Get the base URL and auth headers for log API calls
   */
  private getApiConfig() {
    const proxyAddress = getMCPProxyAddress(this.config);
    const { token, header } = getMCPProxyAuthToken(this.config);

    return {
      baseUrl: proxyAddress,
      headers: {
        [header]: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };
  }

  /**
   * Write a log entry to the server
   */
  async writeLog(entry: LogEntry): Promise<LogTestResponse> {
    const { baseUrl, headers } = this.getApiConfig();

    const response = await fetch(`${baseUrl}/logs/write`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        level: entry.level,
        message: entry.message,
        ...(entry.metadata && { metadata: entry.metadata }),
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to write log: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Get list of available log files
   */
  async getLogFiles(): Promise<LogFilesResponse> {
    const { baseUrl, headers } = this.getApiConfig();

    const response = await fetch(`${baseUrl}/logs`, {
      headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch log files: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Get current log content with pagination
   */
  async getCurrentLogContent(
    page: number = 1,
    limit: number = 50,
  ): Promise<LogContent> {
    const { baseUrl, headers } = this.getApiConfig();

    const response = await fetch(
      `${baseUrl}/logs/current?page=${page}&limit=${limit}`,
      {
        headers,
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch current log content: ${response.statusText}`,
      );
    }

    return await response.json();
  }

  /**
   * Get specific log file content with pagination
   */
  async getLogFileContent(
    filename: string,
    page: number = 1,
    limit: number = 50,
  ): Promise<LogContent> {
    const { baseUrl, headers } = this.getApiConfig();

    const response = await fetch(
      `${baseUrl}/logs/${filename}?page=${page}&limit=${limit}`,
      {
        headers,
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch log file content: ${response.statusText}`,
      );
    }

    return await response.json();
  }

  /**
   * Clean up old log files
   */
  async cleanupLogs(daysToKeep: number = 7): Promise<LogCleanupResponse> {
    const { baseUrl, headers } = this.getApiConfig();

    const response = await fetch(`${baseUrl}/logs/cleanup?days=${daysToKeep}`, {
      method: "DELETE",
      headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to cleanup logs: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Write a simple log message with info level
   */
  async logInfo(
    message: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    try {
      await this.writeLog({ level: "info", message, metadata });
    } catch (error) {
      // Silent fail for logging operations
    }
  }

  /**
   * Write a warning log message
   */
  async logWarning(
    message: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    try {
      await this.writeLog({ level: "warn", message, metadata });
    } catch (error) {
      // Silent fail for logging operations
    }
  }

  /**
   * Write an error log message
   */
  async logError(
    message: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    try {
      await this.writeLog({ level: "error", message, metadata });
    } catch (error) {
      // Silent fail for logging operations
    }
  }

  /**
   * Write a debug log message
   */
  async logDebug(
    message: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    try {
      await this.writeLog({ level: "debug", message, metadata });
    } catch (error) {
      // Silent fail for logging operations
    }
  }
}

/**
 * Create a new ServerLogUtils instance
 */
export const createServerLogUtils = (
  config: InspectorConfig,
): ServerLogUtils => {
  return new ServerLogUtils(config);
};

/**
 * Convenience function to write a log entry without creating a class instance
 */
export const writeLogEntry = async (
  config: InspectorConfig,
  entry: LogEntry,
): Promise<LogTestResponse> => {
  const utils = createServerLogUtils(config);
  return await utils.writeLog(entry);
};

/**
 * Convenience function to write a simple info log
 */
export const logInfo = async (
  config: InspectorConfig,
  message: string,
  metadata?: Record<string, any>,
): Promise<void> => {
  const utils = createServerLogUtils(config);
  return await utils.logInfo(message, metadata);
};

/**
 * Convenience function to write a warning log
 */
export const logWarning = async (
  config: InspectorConfig,
  message: string,
  metadata?: Record<string, any>,
): Promise<void> => {
  const utils = createServerLogUtils(config);
  return await utils.logWarning(message, metadata);
};

/**
 * Convenience function to write an error log
 */
export const logError = async (
  config: InspectorConfig,
  message: string,
  metadata?: Record<string, any>,
): Promise<void> => {
  const utils = createServerLogUtils(config);
  return await utils.logError(message, metadata);
};

/**
 * Convenience function to write a debug log
 */
export const logDebug = async (
  config: InspectorConfig,
  message: string,
  metadata?: Record<string, any>,
): Promise<void> => {
  const utils = createServerLogUtils(config);
  return await utils.logDebug(message, metadata);
};
