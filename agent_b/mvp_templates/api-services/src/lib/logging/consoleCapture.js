/**
 * Console Capture
 * Intercepts console methods to capture logs for structured logging or debugging
 */

const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
};

// Simple pass-through for now, but allows future expansion
// e.g., sending logs to external service or buffering
export function setupConsoleCapture() {
    // Currently we just ensure console methods work as expected
    // but we could attach listeners here
}

// Ensure global console is available
if (typeof console === 'undefined') {
    global.console = {};
}

// Preserve original methods
if (!console._original) {
    console._original = originalConsole;
}

export default originalConsole;
