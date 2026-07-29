/**
 * Clientes HTTP para a Mutual API v2.
 *
 * - `prod`  -> https://apis.mutual.app.br        (merchants, fees)
 * - `hml`   -> https://apis-hml.mutual.app.br    (homologacao)
 * - `crypto`-> aponta para prod OU hml conforme MUTUAL_CRYPTO_ENV (quote)
 *
 * Todos enviam os headers de autenticacao validados:
 *   Authorization: Bearer ak_...
 *   x-service-token: <token>
 *
 * Erros transitorios (429, 5xx, timeout, queda de conexao) sao repetidos
 * automaticamente com backoff — a Mutual oscila e uma falha pontual nao pode
 * derrubar a consulta de merchants/fees nem a fila de cotacoes.
 */

import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from "axios";
import type { AppConfig } from "../config.js";
import { REQUEST_TIMEOUT_MS } from "../constants.js";
import { logger, maskSecret } from "../logger.js";

export interface MutualClients {
  prod: AxiosInstance;
  hml: AxiosInstance;
  crypto: AxiosInstance;
}

/** Tentativas totais por requisicao (1 original + 2 repeticoes). */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

interface RetryConfig extends AxiosRequestConfig {
  /** Contador interno de tentativas ja feitas. */
  __attempt?: number;
}

function isRetriable(error: AxiosError): boolean {
  const status = error.response?.status;
  if (typeof status === "number") {
    // 429 (limite) e 5xx (indisponibilidade) valem nova tentativa.
    return status === 429 || status >= 500;
  }
  // Sem resposta: timeout, DNS, conexao derrubada.
  return true;
}

/** Espera sugerida pelo servidor (Retry-After), em ms — quando presente. */
function retryAfterMs(error: AxiosError): number | null {
  const header = error.response?.headers?.["retry-after"];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  return null;
}

function attachRetry(client: AxiosInstance, label: string): void {
  client.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config = error.config as RetryConfig | undefined;
    if (!config) return Promise.reject(error);

    const attempt = (config.__attempt ?? 0) + 1;
    if (attempt >= MAX_ATTEMPTS || !isRetriable(error)) {
      return Promise.reject(error);
    }

    config.__attempt = attempt;
    const delay = retryAfterMs(error) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
    logger.warn("Repetindo requisição à Mutual após falha transitória", {
      client: label,
      url: config.url,
      status: error.response?.status ?? error.code ?? "sem resposta",
      attempt,
      delayMs: delay,
    });

    await new Promise((resolve) => setTimeout(resolve, delay));
    return client.request(config);
  });
}

function buildClient(baseURL: string, config: AppConfig, label: string): AxiosInstance {
  const client = axios.create({
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-service-token": config.serviceToken,
    },
  });
  attachRetry(client, label);
  return client;
}

export function createMutualClients(config: AppConfig): MutualClients {
  const prod = buildClient(config.prodBaseUrl, config, "prod");
  const hml = buildClient(config.hmlBaseUrl, config, "hml");
  const crypto = config.cryptoEnv === "prod" ? prod : hml;

  logger.info("Clientes Mutual inicializados", {
    prodBaseUrl: config.prodBaseUrl,
    hmlBaseUrl: config.hmlBaseUrl,
    cryptoEnv: config.cryptoEnv,
    apiKey: maskSecret(config.apiKey),
    serviceToken: maskSecret(config.serviceToken),
    retryAttempts: MAX_ATTEMPTS,
  });

  return { prod, hml, crypto };
}
