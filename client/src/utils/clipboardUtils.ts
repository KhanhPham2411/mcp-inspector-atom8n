/**
 * Clipboard utility with fallback mechanisms for when the Clipboard API is blocked
 */

export interface ClipboardResult {
  success: boolean;
  error?: string;
}

/**
 * Copies text to clipboard using the modern Clipboard API with fallback to legacy methods
 * @param text - The text to copy to clipboard
 * @returns Promise that resolves to a result object indicating success or failure
 */
export async function copyToClipboard(text: string): Promise<ClipboardResult> {
  // Try modern Clipboard API first
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      console.warn("Clipboard API failed, trying fallback method:", error);
    }
  }

  // Fallback to legacy method using document.execCommand
  try {
    return await fallbackCopyToClipboard(text);
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to copy to clipboard",
    };
  }
}

/**
 * Fallback method using document.execCommand for older browsers or when Clipboard API is blocked
 * @param text - The text to copy to clipboard
 * @returns Promise that resolves to a result object indicating success or failure
 */
async function fallbackCopyToClipboard(text: string): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    // Create a temporary textarea element
    const textArea = document.createElement("textarea");
    textArea.value = text;

    // Make the textarea invisible but still selectable
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    textArea.style.opacity = "0";
    textArea.style.pointerEvents = "none";
    textArea.setAttribute("readonly", "");

    // Add to DOM, select, and copy
    document.body.appendChild(textArea);

    try {
      // Select the text
      textArea.select();
      textArea.setSelectionRange(0, 99999); // For mobile devices

      // Execute copy command
      const successful = document.execCommand("copy");

      if (successful) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: "execCommand copy failed",
        });
      }
    } catch (error) {
      resolve({
        success: false,
        error:
          error instanceof Error ? error.message : "execCommand copy failed",
      });
    } finally {
      // Clean up
      document.body.removeChild(textArea);
    }
  });
}

/**
 * Checks if the Clipboard API is available and accessible
 * @returns boolean indicating if Clipboard API is available
 */
export function isClipboardAPIAvailable(): boolean {
  return !!(navigator.clipboard && window.isSecureContext);
}

/**
 * Shows a user-friendly error message for clipboard failures
 * @param error - The error message from clipboard operation
 * @returns A user-friendly error message
 */
export function getClipboardErrorMessage(error: string): string {
  if (
    error.includes("permissions policy") ||
    error.includes("Clipboard API has been blocked")
  ) {
    return "Clipboard access is blocked by browser security policy. Please copy the text manually or try using HTTPS.";
  }

  if (error.includes("execCommand")) {
    return "Unable to copy to clipboard. Please select and copy the text manually.";
  }

  return `Failed to copy to clipboard: ${error}`;
}
