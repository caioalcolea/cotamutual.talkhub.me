/**
 * Testes da extracao do preco unitario nos DOIS formatos de resposta do
 * GET /crypto/quote da Mutual, com payloads reais capturados em producao/HML.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveUnitPrice } from "../src/mutual/quote.js";
import type { MutualQuoteData } from "../src/types.js";

// Payload real (formato "ticker") — prioridade: e o preco de mercado correto.
const TICKER: MutualQuoteData = {
  buy: "5.1635",
  sell: "5.1636",
  last: "5.1636",
  high: "5.1659",
  low: "5.1375",
  open: "5.1453",
  vol: "7768643.22971",
  pair: "USDT-BRL",
  date: 1783801754080,
};

// Payload real (formato "quote") — fallback; source/target vem em centavos.
const QUOTE: MutualQuoteData = {
  quote_id: "cc191e02-1f1a-437b-87ad-1f780468de88",
  type: "BUY",
  source_asset: "BRL",
  target_asset: "USDT",
  source_amount: "100000",
  target_amount: "18450.184502",
  price: "5.42",
  fee_bps: 50,
  provider: "MERCADO_BITCOIN",
  locked_at: "2026-07-11T20:12:12.029068414Z",
  expires_at: "2026-07-11T20:12:42.029068414Z",
};

test("deriveUnitPrice ticker: compra usa ask (sell), venda usa bid (buy)", () => {
  assert.equal(deriveUnitPrice(TICKER, "buy"), 5.1636);
  assert.equal(deriveUnitPrice(TICKER, "sell"), 5.1635);
});

test("deriveUnitPrice ticker: fallback para last quando falta um lado", () => {
  const semAsk: MutualQuoteData = { ...TICKER, sell: undefined };
  assert.equal(deriveUnitPrice(semAsk, "buy"), 5.1636); // last
  const semBid: MutualQuoteData = { ...TICKER, buy: undefined };
  assert.equal(deriveUnitPrice(semBid, "sell"), 5.1636); // last
});

test("deriveUnitPrice ticker tem prioridade sobre o formato quote", () => {
  // Se a resposta trouxer os dois conjuntos de campos, vale o ticker.
  const misto: MutualQuoteData = { ...QUOTE, ...TICKER };
  assert.equal(deriveUnitPrice(misto, "buy"), 5.1636);
});

test("deriveUnitPrice quote: razao source/target cancela unidades em centavos", () => {
  const price = deriveUnitPrice(QUOTE, "buy");
  assert.ok(price !== null && Math.abs(price - 5.42) < 0.001);
});

test("deriveUnitPrice quote: usa price quando nao ha amounts", () => {
  const soPrice: MutualQuoteData = { price: "5.42" };
  assert.equal(deriveUnitPrice(soPrice, "buy"), 5.42);
});

test("deriveUnitPrice: null quando nenhum preco reconhecivel", () => {
  assert.equal(deriveUnitPrice({}, "buy"), null);
  assert.equal(deriveUnitPrice({ buy: "0", sell: "-1" } as MutualQuoteData, "buy"), null);
});

// ---------------------------------------------------------------------------
// Estrategia de fonte do preco: ticker do ambiente > ticker da URL alternativa
// (fallback transparente) > formato quote
// ---------------------------------------------------------------------------

import { fetchUnitPriceBRL } from "../src/mutual/quote.js";
import type { MutualClients } from "../src/mutual/client.js";

function fakeClients(prodData: MutualQuoteData | Error, hmlData: MutualQuoteData | Error) {
  const calls = { prod: 0, hml: 0 };
  const mk = (data: MutualQuoteData | Error, key: "prod" | "hml") => ({
    get: async () => {
      calls[key] += 1;
      if (data instanceof Error) throw data;
      return { data: { error: false, message: "ok", data } };
    },
  });
  const prod = mk(prodData, "prod");
  const hml = mk(hmlData, "hml");
  const clients = { prod, hml, crypto: prod } as unknown as MutualClients;
  return { clients, calls };
}

test("fetchUnitPriceBRL: prod com formato quote -> busca ticker na alternativa", async () => {
  const { clients, calls } = fakeClients(QUOTE, TICKER);
  const r = await fetchUnitPriceBRL(clients, "USDT", 1000, "buy");
  assert.equal(r.source, "ticker-fallback");
  assert.equal(r.unitPriceBRL, 5.1636); // ask do ticker, sem o 5.42 do provider
  assert.equal(calls.prod, 1);
  assert.equal(calls.hml, 1);
});

test("fetchUnitPriceBRL: prod ja com ticker -> nao consulta a alternativa", async () => {
  const { clients, calls } = fakeClients(TICKER, QUOTE);
  const r = await fetchUnitPriceBRL(clients, "USDT", 1000, "sell");
  assert.equal(r.source, "ticker");
  assert.equal(r.unitPriceBRL, 5.1635); // bid
  assert.equal(calls.hml, 0);
});

test("fetchUnitPriceBRL: alternativa falha -> usa o formato quote do primario", async () => {
  const { clients } = fakeClients(QUOTE, new Error("hml fora do ar"));
  const r = await fetchUnitPriceBRL(clients, "USDT", 1000, "buy");
  assert.equal(r.source, "quote");
  assert.ok(Math.abs(r.unitPriceBRL - 5.42) < 0.001);
});

test("fetchUnitPriceBRL: fallback desativado -> nunca toca a alternativa", async () => {
  const { clients, calls } = fakeClients(QUOTE, TICKER);
  const r = await fetchUnitPriceBRL(clients, "USDT", 1000, "buy", false);
  assert.equal(r.source, "quote");
  assert.equal(calls.hml, 0);
});
