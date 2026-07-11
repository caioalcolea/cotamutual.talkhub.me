/**
 * Constantes compartilhadas do servico cotamutual.
 */

export const SERVICE_NAME = "cotamutual";
export const SERVICE_VERSION = "2.0.0";

/** Base URLs padrao da Mutual API v2. */
export const DEFAULT_PROD_BASE_URL = "https://apis.mutual.app.br";
export const DEFAULT_HML_BASE_URL = "https://apis-hml.mutual.app.br";

/** Timeout padrao das chamadas HTTP a Mutual (ms). */
export const REQUEST_TIMEOUT_MS = 30000;

/** Rede padrao usada na consulta de cotacao, por ativo. */
export const ASSET_NETWORKS: Record<string, string> = {
  BTC: "BITCOIN",
  ETH: "ERC20",
  USDT: "TRON",
  USDC: "ERC20",
};
