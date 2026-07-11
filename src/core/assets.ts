/**
 * Normalizacao dos ativos (secao 8 do descritivo).
 *
 * Regra do projeto: dolar americano e representado por USDC (USD = USDC).
 */

export const FIAT_ASSETS = new Set(["BRL"]);

export const CRYPTO_ASSETS = new Set(["BTC", "ETH", "USDT", "USDC"]);

export const ASSET_ALIASES: Record<string, string> = {
  REAL: "BRL",
  REAIS: "BRL",
  BRL: "BRL",
  DOLAR: "USDC",
  "DÓLAR": "USDC",
  DOLARES: "USDC",
  "DÓLARES": "USDC",
  USD: "USDC",
  USDC: "USDC",
  USDT: "USDT",
  TETHER: "USDT",
  BITCOIN: "BTC",
  BTC: "BTC",
  ETHEREUM: "ETH",
  ETH: "ETH",
};

export function normalizeAsset(value: string | null | undefined): string {
  const key = String(value || "").trim().toUpperCase();
  return ASSET_ALIASES[key] || key;
}

export function isKnownAsset(value: string): boolean {
  const asset = normalizeAsset(value);
  return FIAT_ASSETS.has(asset) || CRYPTO_ASSETS.has(asset);
}
