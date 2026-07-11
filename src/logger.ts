/**
 * Logger simples em JSON (stderr), com mascaramento de segredos.
 */

export function maskSecret(value: string | undefined | null): string {
  if (!value) return "(vazio)";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ? { meta } : {}),
  };
  console.error(JSON.stringify(entry));
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>): void => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>): void => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>): void => emit("error", msg, meta),
};
