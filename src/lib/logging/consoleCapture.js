/**
 * Runtime console capture for downloadable logs.
 * Captures stdout/stderr (console.log/warn/error) into a ring buffer.
 *
 * IMPORTANT:
 * - Must not recurse (never call console.* from inside the wrapper).
 * - Idempotent: safe to import multiple times.
 */
const GLOBAL_FLAG = '__mwConsoleCaptureInstalled';
const GLOBAL_BUFFER = '__mwConsoleCaptureBuffer';
const GLOBAL_ORIGINALS = '__mwConsoleCaptureOriginals';

const DEFAULT_MAX_ENTRIES = 5000;

function safeStringify(value) {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '[Unserializable]';
    }
  }
}

function normalizeArgs(args) {
  return args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
}

function ensureCaptureInstalled() {
  if (globalThis[GLOBAL_FLAG]) return;

  // Initialize shared buffer
  globalThis[GLOBAL_BUFFER] = globalThis[GLOBAL_BUFFER] || [];

  const originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  globalThis[GLOBAL_ORIGINALS] = originals;

  const push = (level, args) => {
    const buf = globalThis[GLOBAL_BUFFER];
    const entry = {
      ts: new Date().toISOString(),
      level,
      message: normalizeArgs(args),
    };
    buf.push(entry);
    if (buf.length > DEFAULT_MAX_ENTRIES) {
      buf.splice(0, buf.length - DEFAULT_MAX_ENTRIES);
    }
  };

  console.log = (...args) => {
    push('log', args);
    originals.log(...args);
  };
  console.warn = (...args) => {
    push('warn', args);
    originals.warn(...args);
  };
  console.error = (...args) => {
    push('error', args);
    originals.error(...args);
  };

  globalThis[GLOBAL_FLAG] = true;
}

export function getCapturedConsoleEntries(limit = DEFAULT_MAX_ENTRIES) {
  ensureCaptureInstalled();
  const buf = globalThis[GLOBAL_BUFFER] || [];
  if (!limit || limit >= buf.length) return [...buf];
  return buf.slice(buf.length - limit);
}

export function formatCapturedConsoleEntries(limit = DEFAULT_MAX_ENTRIES) {
  const entries = getCapturedConsoleEntries(limit);
  return entries.map(e => `[${e.ts}] [${e.level}] ${e.message}`);
}

// Install immediately on import
ensureCaptureInstalled();


