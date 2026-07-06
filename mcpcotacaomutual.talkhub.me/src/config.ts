/**
 * Carregamento e validacao das variaveis de ambiente.
 */

import { DEFAULT_HML_BASE_URL, DEFAULT_PROD_BASE_URL } from "./constants.js";

export type CryptoEnv = "hml" | "prod";
export type TransportKind = "http" | "stdio";

export interface AppConfig {
  port: number;
  transport: TransportKind;
  prodBaseUrl: string;
  hmlBaseUrl: string;
  cryptoEnv: CryptoEnv;
  apiKey: string;
  serviceToken: string;
  /** Token Bearer exigido no endpoint /mcp. Null = sem autenticacao. */
  mcpAuthToken: string | null;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`ERRO: variavel de ambiente obrigatoria ausente: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

export function loadConfig(): AppConfig {
  const rawCryptoEnv = (process.env.MUTUAL_CRYPTO_ENV || "hml").toLowerCase();
  if (rawCryptoEnv !== "hml" && rawCryptoEnv !== "prod") {
    console.error(`ERRO: MUTUAL_CRYPTO_ENV invalido: "${rawCryptoEnv}" (use "hml" ou "prod")`);
    process.exit(1);
  }

  const rawTransport = (process.env.TRANSPORT || "http").toLowerCase();
  const transport: TransportKind = rawTransport === "stdio" ? "stdio" : "http";

  const port = Number.parseInt(process.env.PORT || "3000", 10);
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`ERRO: PORT invalido: "${process.env.PORT}"`);
    process.exit(1);
  }

  return {
    port,
    transport,
    prodBaseUrl: process.env.MUTUAL_PROD_BASE_URL?.trim() || DEFAULT_PROD_BASE_URL,
    hmlBaseUrl: process.env.MUTUAL_HML_BASE_URL?.trim() || DEFAULT_HML_BASE_URL,
    cryptoEnv: rawCryptoEnv as CryptoEnv,
    apiKey: required("MUTUAL_API_KEY"),
    serviceToken: required("MUTUAL_SERVICE_TOKEN"),
    mcpAuthToken: process.env.MCP_AUTH_TOKEN?.trim() || null,
  };
}
