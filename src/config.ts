/**
 * Carregamento e validacao das variaveis de ambiente.
 */

import { DEFAULT_HML_BASE_URL, DEFAULT_PROD_BASE_URL } from "./constants.js";

export type CryptoEnv = "hml" | "prod";
export type OutboundMode = "evolution" | "webhook" | "log";

export interface AppConfig {
  port: number;
  prodBaseUrl: string;
  hmlBaseUrl: string;
  cryptoEnv: CryptoEnv;
  apiKey: string;
  serviceToken: string;

  /** Fase atual: enquanto false, POST /api/v2/crypto/orders NUNCA e chamado. */
  ordersEnabled: boolean;

  /** Fila de cotacoes: quantidade de mensagens e intervalo entre elas. */
  quoteQueueMessages: number;
  quoteQueueIntervalMs: number;
  /** Valor BRL de referencia para descobrir preco unitario. */
  quoteReferenceBrlAmount: number;

  merchantCacheTtlMs: number;
  feeCacheTtlMs: number;

  dataDir: string;

  webhookToken: string | null;
  panelToken: string | null;

  outboundMode: OutboundMode;
  outboundWebhookUrl: string | null;
  outboundToken: string | null;

  /** Evolution API (OUTBOUND_MODE=evolution): envio de mensagens ao grupo. */
  evolutionBaseUrl: string | null;
  evolutionInstance: string | null;
  evolutionApiKey: string | null;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`ERRO: variavel de ambiente obrigatoria ausente: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    console.error(`ERRO: ${name} invalido: "${raw}" (minimo ${min})`);
    process.exit(1);
  }
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

export function loadConfig(): AppConfig {
  const rawCryptoEnv = (process.env.MUTUAL_CRYPTO_ENV || "hml").toLowerCase();
  if (rawCryptoEnv !== "hml" && rawCryptoEnv !== "prod") {
    console.error(`ERRO: MUTUAL_CRYPTO_ENV invalido: "${rawCryptoEnv}" (use "hml" ou "prod")`);
    process.exit(1);
  }

  const rawOutbound = (process.env.OUTBOUND_MODE || "log").toLowerCase();
  if (rawOutbound !== "evolution" && rawOutbound !== "webhook" && rawOutbound !== "log") {
    console.error(
      `ERRO: OUTBOUND_MODE invalido: "${rawOutbound}" (use "evolution", "webhook" ou "log")`,
    );
    process.exit(1);
  }
  const outboundWebhookUrl = process.env.OUTBOUND_WEBHOOK_URL?.trim() || null;
  if (rawOutbound === "webhook" && !outboundWebhookUrl) {
    console.error("ERRO: OUTBOUND_MODE=webhook exige OUTBOUND_WEBHOOK_URL definido.");
    process.exit(1);
  }

  const evolutionBaseUrl =
    process.env.EVOLUTION_BASE_URL?.trim().replace(/\/+$/, "") || null;
  const evolutionInstance = process.env.EVOLUTION_INSTANCE?.trim() || null;
  const evolutionApiKey = process.env.EVOLUTION_API_KEY?.trim() || null;
  if (rawOutbound === "evolution" && (!evolutionBaseUrl || !evolutionInstance || !evolutionApiKey)) {
    console.error(
      "ERRO: OUTBOUND_MODE=evolution exige EVOLUTION_BASE_URL, EVOLUTION_INSTANCE e EVOLUTION_API_KEY.",
    );
    process.exit(1);
  }

  return {
    port: intEnv("PORT", 3000, 1),
    prodBaseUrl: process.env.MUTUAL_PROD_BASE_URL?.trim() || DEFAULT_PROD_BASE_URL,
    hmlBaseUrl: process.env.MUTUAL_HML_BASE_URL?.trim() || DEFAULT_HML_BASE_URL,
    cryptoEnv: rawCryptoEnv as CryptoEnv,
    apiKey: required("MUTUAL_API_KEY"),
    serviceToken: required("MUTUAL_SERVICE_TOKEN"),

    ordersEnabled: boolEnv("ORDERS_ENABLED", false),

    quoteQueueMessages: intEnv("QUOTE_QUEUE_MESSAGES", 10, 1),
    quoteQueueIntervalMs: intEnv("QUOTE_QUEUE_INTERVAL_MS", 3000, 500),
    quoteReferenceBrlAmount: intEnv("QUOTE_REFERENCE_BRL_AMOUNT", 1000, 1),

    merchantCacheTtlMs: intEnv("MERCHANT_CACHE_TTL_MS", 60_000, 5_000),
    feeCacheTtlMs: intEnv("FEE_CACHE_TTL_MS", 60_000, 5_000),

    dataDir: process.env.DATA_DIR?.trim() || "./data",

    webhookToken: process.env.WEBHOOK_TOKEN?.trim() || null,
    panelToken: process.env.PANEL_TOKEN?.trim() || null,

    outboundMode: rawOutbound as OutboundMode,
    outboundWebhookUrl,
    outboundToken: process.env.OUTBOUND_TOKEN?.trim() || null,

    evolutionBaseUrl,
    evolutionInstance,
    evolutionApiKey,
  };
}
