/**
 * Cotacao-base na Mutual:
 *   GET /api/v2/crypto/quote   (cliente "crypto" -> hml ou prod via MUTUAL_CRYPTO_ENV)
 *
 * Cotacao NUNCA usa cache: cada chamada e uma requisicao nova, pois os precos
 * variam de segundo a segundo.
 */

import type { MutualClients } from "./client.js";
import type { MutualQuoteData, MutualQuoteResponse } from "../types.js";
import { ASSET_NETWORKS } from "../constants.js";

export interface TickerRequest {
  symbol: string;
  amount: number;
  sourceAsset: string;
  targetAsset: string;
  targetNetwork: string;
}

export async function fetchMutualQuote(
  clients: MutualClients,
  input: TickerRequest,
): Promise<MutualQuoteData> {
  const response = await clients.crypto.get<MutualQuoteResponse>("/api/v2/crypto/quote", {
    params: {
      symbol: input.symbol,
      amount: input.amount,
      sourceAsset: input.sourceAsset,
      targetAsset: input.targetAsset,
      targetNetwork: input.targetNetwork,
    },
  });
  return response.data.data;
}

export interface UnitPriceResult {
  /** Preco de 1 unidade do ativo, em BRL. */
  unitPriceBRL: number;
  rawTicker: MutualQuoteData;
}

/**
 * Descobre o preco unitario (BRL por 1 unidade do ativo) fazendo uma cotacao
 * BRL -> ativo com um valor de referencia. Preferimos derivar de
 * source_amount / target_amount; se indisponivel, usamos o campo `price`.
 */
export async function fetchUnitPriceBRL(
  clients: MutualClients,
  asset: string,
  referenceBrlAmount: number,
): Promise<UnitPriceResult> {
  const ticker = await fetchMutualQuote(clients, {
    symbol: `${asset}-BRL`,
    amount: referenceBrlAmount,
    sourceAsset: "BRL",
    targetAsset: asset,
    targetNetwork: ASSET_NETWORKS[asset] ?? "BITCOIN",
  });

  const sourceAmount = Number(ticker.source_amount);
  const targetAmount = Number(ticker.target_amount);
  let unitPriceBRL: number;
  if (
    Number.isFinite(sourceAmount) &&
    Number.isFinite(targetAmount) &&
    sourceAmount > 0 &&
    targetAmount > 0
  ) {
    unitPriceBRL = sourceAmount / targetAmount;
  } else {
    unitPriceBRL = Number(ticker.price);
  }

  if (!Number.isFinite(unitPriceBRL) || unitPriceBRL <= 0) {
    throw new Error(`Cotacao-base invalida para ${asset}: price=${ticker.price}`);
  }

  return { unitPriceBRL, rawTicker: ticker };
}
