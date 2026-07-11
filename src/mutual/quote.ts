/**
 * Cotacao-base na Mutual:
 *   GET /api/v2/crypto/quote   (cliente "crypto" -> hml ou prod via MUTUAL_CRYPTO_ENV)
 *
 * Cotacao NUNCA usa cache: cada chamada e uma requisicao nova, pois os precos
 * variam de segundo a segundo.
 *
 * A API responde em dois formatos (ver types.ts):
 *   - "quote":  source_amount/target_amount/price  -> preco = source/target
 *   - "ticker": buy/sell/last                      -> preco escolhido pelo lado:
 *       cliente COMPRA o ativo -> paga o ask  (campo "sell")
 *       cliente VENDE o ativo  -> recebe o bid (campo "buy")
 *       fallback: "last", depois o outro lado.
 */

import type { MutualClients } from "./client.js";
import type { MutualQuoteData, MutualQuoteResponse } from "../types.js";
import { ASSET_NETWORKS } from "../constants.js";

/** Lado da operacao do CLIENTE sobre o ativo cotado. */
export type QuoteSide = "buy" | "sell";

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

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Extrai o preco unitario (BRL por 1 unidade do ativo) de qualquer um dos
 * formatos de resposta. Exportada para testes.
 *
 * PRIORIDADE: o formato "ticker" (buy/sell/last) e o preco de mercado correto
 * para a cotacao-base — a fee do merchant e aplicada por cima. O formato
 * "quote" (source/target/price) so e usado como fallback, pois embute spread
 * do provider.
 */
export function deriveUnitPrice(data: MutualQuoteData, side: QuoteSide): number | null {
  // 1) Formato "ticker": lado correto do book, com fallbacks.
  const tickerCandidates =
    side === "buy" ? [data.sell, data.last, data.buy] : [data.buy, data.last, data.sell];
  for (const candidate of tickerCandidates) {
    const value = positiveNumber(candidate);
    if (value !== null) return value;
  }

  // 2) Formato "quote": razao source/target (imune a unidades em centavos,
  //    pois a razao cancela o fator).
  const source = positiveNumber(data.source_amount);
  const target = positiveNumber(data.target_amount);
  if (source !== null && target !== null) {
    return source / target;
  }

  // 3) Ultimo recurso: campo price do formato "quote".
  return positiveNumber(data.price);
}

export interface UnitPriceResult {
  /** Preco de 1 unidade do ativo, em BRL. */
  unitPriceBRL: number;
  rawTicker: MutualQuoteData;
}

/**
 * Descobre o preco unitario (BRL por 1 unidade do ativo) fazendo uma cotacao
 * BRL -> ativo com um valor de referencia.
 *
 * `side` = lado do CLIENTE sobre o ativo: "buy" quando ele compra o ativo,
 * "sell" quando ele vende (define qual ponta do book usar no formato ticker).
 */
export async function fetchUnitPriceBRL(
  clients: MutualClients,
  asset: string,
  referenceBrlAmount: number,
  side: QuoteSide = "buy",
): Promise<UnitPriceResult> {
  const ticker = await fetchMutualQuote(clients, {
    symbol: `${asset}-BRL`,
    amount: referenceBrlAmount,
    sourceAsset: "BRL",
    targetAsset: asset,
    targetNetwork: ASSET_NETWORKS[asset] ?? "BITCOIN",
  });

  const unitPriceBRL = deriveUnitPrice(ticker, side);
  if (unitPriceBRL === null) {
    throw new Error(
      `Cotação-base sem preço reconhecível para ${asset}: ${JSON.stringify(ticker).slice(0, 300)}`,
    );
  }

  return { unitPriceBRL, rawTicker: ticker };
}
