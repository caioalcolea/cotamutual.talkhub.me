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
 */

import axios, { type AxiosInstance } from "axios";
import type { AppConfig } from "../config.js";
import { REQUEST_TIMEOUT_MS } from "../constants.js";
import { logger, maskSecret } from "../logger.js";

export interface MutualClients {
  prod: AxiosInstance;
  hml: AxiosInstance;
  crypto: AxiosInstance;
}

function buildClient(baseURL: string, config: AppConfig): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-service-token": config.serviceToken,
    },
  });
}

export function createMutualClients(config: AppConfig): MutualClients {
  const prod = buildClient(config.prodBaseUrl, config);
  const hml = buildClient(config.hmlBaseUrl, config);
  const crypto = config.cryptoEnv === "prod" ? prod : hml;

  logger.info("Clientes Mutual inicializados", {
    prodBaseUrl: config.prodBaseUrl,
    hmlBaseUrl: config.hmlBaseUrl,
    cryptoEnv: config.cryptoEnv,
    apiKey: maskSecret(config.apiKey),
    serviceToken: maskSecret(config.serviceToken),
  });

  return { prod, hml, crypto };
}
