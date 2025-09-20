import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class Logger {
  private logsDir: string;
  private logFile: string;

  constructor() {
    // Get the directory of the current module
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    
    this.logsDir = path.join(__dirname, '..', 'logs');
    this.ensureLogsDirectory();
    this.logFile = path.join(this.logsDir, this.getLogFileName());
  }

  private ensureLogsDirectory(): void {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  private getLogFileName(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD format
    return `server-${dateStr}.log`;
  }

  private formatMessage(level: string, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length > 0 ? ' ' + args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ') : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${formattedArgs}`;
  }

  private writeToFile(formattedMessage: string): void {
    try {
      fs.appendFileSync(this.logFile, formattedMessage + '\n');
    } catch (error) {
      console.error('Failed to write to log file:', (error as Error).message);
    }
  }

  private log(level: string, message: string, ...args: any[]): void {
    const formattedMessage = this.formatMessage(level, message, ...args);
    
    // Write to console
    if (level === 'error') {
      console.error(formattedMessage);
    } else {
      console.log(formattedMessage);
    }
    
    // Write to file
    this.writeToFile(formattedMessage);
  }

  info(message: string, ...args: any[]): void {
    this.log('info', message, ...args);
  }

  error(message: string, ...args: any[]): void {
    this.log('error', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.log('warn', message, ...args);
  }

  debug(message: string, ...args: any[]): void {
    this.log('debug', message, ...args);
  }

  // Method to get log file path for API endpoints
  getLogFilePath(): string {
    return this.logFile;
  }

  // Method to get logs directory for API endpoints
  getLogsDirectory(): string {
    return this.logsDir;
  }

  // Method to read log file content
  readLogFile(): string {
    try {
      return fs.readFileSync(this.logFile, 'utf8');
    } catch (error) {
      throw new Error(`Failed to read log file: ${(error as Error).message}`);
    }
  }

  // Method to get list of available log files
  getAvailableLogFiles(): string[] {
    try {
      return fs.readdirSync(this.logsDir)
        .filter(file => file.endsWith('.log'))
        .sort()
        .reverse(); // Most recent first
    } catch (error) {
      throw new Error(`Failed to read logs directory: ${(error as Error).message}`);
    }
  }

  // Method to read a specific log file
  readSpecificLogFile(filename: string): string {
    const filePath = path.join(this.logsDir, filename);
    
    // Security check: ensure the file is within the logs directory
    if (!filePath.startsWith(this.logsDir)) {
      throw new Error('Invalid log file path');
    }
    
    if (!filename.endsWith('.log')) {
      throw new Error('Invalid log file extension');
    }
    
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new Error(`Failed to read log file ${filename}: ${(error as Error).message}`);
    }
  }

  // Method to clear log files (keep only last N days)
  clearOldLogs(daysToKeep: number = 7): void {
    try {
      const files = this.getAvailableLogFiles();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      
      files.forEach(filename => {
        // Extract date from filename (server-YYYY-MM-DD.log)
        const dateMatch = filename.match(/server-(\d{4}-\d{2}-\d{2})\.log/);
        if (dateMatch) {
          const fileDate = new Date(dateMatch[1]);
          if (fileDate < cutoffDate) {
            const filePath = path.join(this.logsDir, filename);
            fs.unlinkSync(filePath);
            this.info(`Deleted old log file: ${filename}`);
          }
        }
      });
    } catch (error) {
      this.error('Failed to clear old logs:', error);
    }
  }
}

// Create and export a singleton instance
const logger = new Logger();
export default logger;
