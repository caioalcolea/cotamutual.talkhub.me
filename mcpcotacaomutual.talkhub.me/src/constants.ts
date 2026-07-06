/**
 * Constantes compartilhadas do servidor MCP.
 */

export const SERVER_NAME = "mutual-crypto-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Limite de caracteres para respostas grandes (proteção de contexto do agente). */
export const CHARACTER_LIMIT = 25000;

/** Base URLs padrão da Mutual API v2. */
export const DEFAULT_PROD_BASE_URL = "https://apis.mutual.app.br";
export const DEFAULT_HML_BASE_URL = "https://apis-hml.mutual.app.br";

/** Timeout padrão das chamadas HTTP à Mutual (ms). */
export const REQUEST_TIMEOUT_MS = 30000;
