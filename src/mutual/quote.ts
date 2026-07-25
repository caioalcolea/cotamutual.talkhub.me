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

import type { AxiosInstance } from "axios";
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
  client: AxiosInstance,
  input: TickerRequest,
): Promise<MutualQuoteData> {
  const response = await client.get<MutualQuoteResponse>("/api/v2/crypto/quote", {
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

/** true quando a resposta traz preco de ticker (buy/sell/last). */
export function hasTickerPrice(data: MutualQuoteData): boolean {
  return [data.buy, data.sell, data.last].some((v) => positiveNumber(v) !== null);
}

/** De onde saiu o preco-base usado. */
export type PriceSource = "ticker" | "ticker-fallback" | "quote";

interface RawTickerResult {
  data: MutualQuoteData;
  source: PriceSource;
}

/**
 * Busca o ticker do ativo aplicando a estrategia de fonte:
 *   1. ambiente configurado; se vier TICKER (preco de mercado), usa;
 *   2. se vier o formato "quote" (spread de provider), tenta o ticker na URL
 *      alternativa (fallback transparente);
 *   3. ultimo recurso: o proprio formato "quote".
 */
async function fetchRawTicker(
  clients: MutualClients,
  asset: string,
  referenceBrlAmount: number,
  tickerFallback: boolean,
): Promise<RawTickerResult> {
  const request: TickerRequest = {
    symbol: `${asset}-BRL`,
    amount: referenceBrlAmount,
    sourceAsset: "BRL",
    targetAsset: asset,
    targetNetwork: ASSET_NETWORKS[asset] ?? "BITCOIN",
  };

  const primary = await fetchMutualQuote(clients.crypto, request);
  if (hasTickerPrice(primary)) {
    return { data: primary, source: "ticker" };
  }

  if (tickerFallback) {
    const alternate = clients.crypto === clients.prod ? clients.hml : clients.prod;
    try {
      const secondary = await fetchMutualQuote(alternate, request);
      if (hasTickerPrice(secondary)) {
        return { data: secondary, source: "ticker-fallback" };
      }
    } catch {
      // URL alternativa indisponivel: segue com o formato "quote" do primario.
    }
  }

  return { data: primary, source: "quote" };
}

export interface UnitPriceResult {
  /** Preco de 1 unidade do ativo, em BRL — SEM fee (a fee do merchant e aplicada por cima). */
  unitPriceBRL: number;
  rawTicker: MutualQuoteData;
  source: PriceSource;
}

/**
 * Preco unitario (BRL por 1 unidade do ativo) de UM lado do book.
 *
 * `side` = lado do CLIENTE sobre o ativo: "buy" quando ele compra o ativo,
 * "sell" quando ele vende.
 */
export async function fetchUnitPriceBRL(
  clients: MutualClients,
  asset: string,
  referenceBrlAmount: number,
  side: QuoteSide = "buy",
  tickerFallback = true,
): Promise<UnitPriceResult> {
  const { data, source } = await fetchRawTicker(clients, asset, referenceBrlAmount, tickerFallback);
  const unitPriceBRL = deriveUnitPrice(data, side);
  if (unitPriceBRL === null) {
    throw new Error(
      `Cotação-base sem preço reconhecível para ${asset}: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }
  return { unitPriceBRL, rawTicker: data, source };
}

export interface TickerSidesResult {
  /** Preco para o cliente COMPRAR o ativo (ask), em BRL — sem fee. */
  askBRL: number;
  /** Preco para o cliente VENDER o ativo (bid), em BRL — sem fee. */
  bidBRL: number;
  rawTicker: MutualQuoteData;
  source: PriceSource;
}

/**
 * Os DOIS lados do book em UMA requisicao (a resposta ticker ja traz bid e ask).
 *
 * Invariante garantida: askBRL >= bidBRL. Se a resposta vier invertida (dado
 * estranho / fallback para "last"), os lados sao normalizados para nunca
 * cotar uma venda acima da compra.
 */
export async function fetchTickerBRL(
  clients: MutualClients,
  asset: string,
  referenceBrlAmount: number,
  tickerFallback = true,
): Promise<TickerSidesResult> {
  const { data, source } = await fetchRawTicker(clients, asset, referenceBrlAmount, tickerFallback);

  const ask = deriveUnitPrice(data, "buy");
  const bid = deriveUnitPrice(data, "sell");
  if (ask === null && bid === null) {
    throw new Error(
      `Cotação-base sem preço reconhecível para ${asset}: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  const a = ask ?? (bid as number);
  const b = bid ?? (ask as number);
  return {
    askBRL: Math.max(a, b),
    bidBRL: Math.min(a, b),
    rawTicker: data,
    source,
  };
}
