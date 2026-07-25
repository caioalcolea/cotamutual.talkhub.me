/**
 * Testes da fila de cotacoes e do formato de resposta (mesa OTC).
 *
 *   - a cotacao do par sai com os DOIS lados (compra e venda);
 *   - lado sem fee cadastrada sai como "sob consulta" (nunca numero errado);
 *   - a ultima cotacao sobrevive ao fim da fila (TTL) e e CONSUMIDA na
 *     confirmacao (uma confirmacao por cotacao);
 *   - registro da operacao no formato do painel da Mutual.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { QuoteQueue } from "../src/queue/quote-queue.js";
import { QuoteLogRepository } from "../src/state/quote-log.js";
import { formatOperationRecord, formatPairQuoteMessage } from "../src/core/format.js";
import type { PairContext, QuoteEngine, SideQuote } from "../src/core/engine.js";
import type { OutboundSender } from "../src/channels/outbound.js";

function buildContext(): PairContext {
  return {
    mode: "pair",
    channel: "whatsapp",
    groupId: "G1",
    merchant: { id: "org_1", status: "active", legalName: "Cliente" },
    command: "/COTAR 50K USDT",
    amount: 50_000,
    amountRaw: "50k",
    asset: "USDT",
    sizeKind: "asset",
    buy: { operation: "buy", fee: { id: "fee_buy", feeFixed: 0, feePercentage: 0.65 } },
    sell: { operation: "sell", fee: { id: "fee_sell", feeFixed: 0, feePercentage: 0.65 } },
  };
}

function side(kind: "buy" | "sell", unitPrice: number, quantity: number): SideQuote {
  return {
    side: kind,
    operation: kind,
    feeId: `fee_${kind}`,
    feeFixed: 0,
    feePercentage: 0.65,
    feeRate: 0.0065,
    basePrice: unitPrice,
    unitPrice,
    quantity,
    totalBRL: unitPrice * quantity,
  };
}

function buildQueue(totalMessages: number) {
  const sent: string[] = [];
  const engine = {
    tick: async (ctx: PairContext) => ({
      mode: "pair" as const,
      asset: ctx.asset,
      sizeKind: ctx.sizeKind,
      amount: ctx.amount,
      buy: side("buy", 5.0051, ctx.amount),
      sell: side("sell", 4.9891, ctx.amount),
      rawTickers: [],
      priceSources: ["ticker"],
      usdRateBRL: null,
    }),
  } as unknown as QuoteEngine;
  const outbound = {
    send: async (m: { text: string }) => {
      sent.push(m.text);
      return true;
    },
  } as unknown as OutboundSender;
  const quoteLog = new QuoteLogRepository(mkdtempSync(join(tmpdir(), "cotamutual-queue-")));
  return { queue: new QuoteQueue(engine, outbound, quoteLog, totalMessages, 600, "D0"), sent };
}

// ---------------------------------------------------------------------------
// Formato da mensagem
// ---------------------------------------------------------------------------

test("formatPairQuoteMessage: layout da mesa (compra e venda) com 50k", () => {
  const msg = formatPairQuoteMessage({
    asset: "USDT",
    sizeKind: "asset",
    amountRaw: "50k",
    amount: 50_000,
    buy: side("buy", 5.0051, 50_000),
    sell: side("sell", 4.9891, 50_000),
    sequence: 3,
    total: 10,
    settlementLabel: "D0",
  });

  assert.match(msg, /^💱 Cotação · USDT D0 • 🇧🇷 USDT\/BRL · 3\/10/);
  assert.match(msg, /🟢 Compra: 1 USDT = R\$ 5,0051/);
  assert.match(msg, /50k USDT = R\$\s250\.255,00/);
  assert.match(msg, /🔴 Venda: 1 USDT = R\$ 4,9891/);
  assert.match(msg, /50k USDT = R\$\s249\.455,00/);
  assert.match(msg, /🧾 Digite\n→ \/compra 50k USDT\n→ \/venda 50k USDT/);
  assert.match(msg, /⚡ Valores sujeitos à confirmação no fechamento\./);
  // Nenhum detalhe interno vaza para o grupo.
  assert.ok(!msg.includes("fee"));
  assert.ok(!/0,65/.test(msg));
});

test("formatPairQuoteMessage: quantidade 1 nao repete a linha do tamanho", () => {
  const msg = formatPairQuoteMessage({
    asset: "USDT",
    sizeKind: "asset",
    amountRaw: "1",
    amount: 1,
    buy: side("buy", 5.0051, 1),
    sell: side("sell", 4.9891, 1),
    sequence: 1,
    total: 10,
    settlementLabel: "D0",
  });
  assert.match(msg, /🟢 Compra: 1 USDT = R\$ 5,0051\n🔴 Venda: 1 USDT = R\$ 4,9891/);
  assert.match(msg, /→ \/compra 1 USDT/);
});

test("formatPairQuoteMessage: lado sem fee sai como sob consulta, sem comando", () => {
  const msg = formatPairQuoteMessage({
    asset: "USDT",
    sizeKind: "asset",
    amountRaw: "50k",
    amount: 50_000,
    buy: side("buy", 5.0051, 50_000),
    sell: null, // fee de venda nao cadastrada
    sequence: 1,
    total: 10,
    settlementLabel: "D0",
  });
  assert.match(msg, /🔴 Venda: sob consulta/);
  assert.match(msg, /→ \/compra 50k USDT/);
  assert.ok(!msg.includes("/venda"), "sem fee de venda, o comando não é oferecido");
  assert.match(msg, /A venda deste par será conduzida manualmente/);
});

test("formatPairQuoteMessage: tamanho em BRL mostra as duas direções", () => {
  const buy = side("buy", 5.0051, 5000 / 5.0051);
  buy.totalBRL = 5000;
  const sell = side("sell", 4.9891, 5000 / 4.9891);
  sell.totalBRL = 5000;
  const msg = formatPairQuoteMessage({
    asset: "USDT",
    sizeKind: "brl",
    amountRaw: "5000",
    amount: 5000,
    buy,
    sell,
    sequence: 1,
    total: 10,
    settlementLabel: "D0",
  });
  assert.match(msg, /🟢 Compra: 1 USDT = R\$ 5,0051\nR\$\s5\.000,00 = 998,98/);
  assert.match(msg, /🔴 Venda: 1 USDT = R\$ 4,9891\n1\.002,18 USDT = R\$\s5\.000,00/);
  assert.match(msg, /→ \/compra 5000 BRL USDT/);
  assert.match(msg, /→ \/venda 5000 BRL USDT/);
});

// ---------------------------------------------------------------------------
// Ciclo de vida da cotacao
// ---------------------------------------------------------------------------

test("fila concluida: a cotacao continua disponivel para confirmar (TTL)", async () => {
  const { queue, sent } = buildQueue(1);
  queue.start(buildContext());

  for (let i = 0; i < 40 && queue.snapshot().active.length > 0; i += 1) {
    await sleep(50);
  }
  assert.equal(queue.snapshot().active.length, 0);
  assert.ok(sent.some((t) => t.startsWith("💱 Cotação")));

  const last = queue.peekLastQuote("whatsapp", "G1");
  assert.ok(last, "cotação deveria sobreviver ao fim da fila");
  assert.equal(last.asset, "USDT");
  assert.equal(last.mode, "pair");
  assert.ok(last.buy && last.sell);
});

test("cotacao e CONSUMIDA na confirmacao: a proxima exige cotacao nova", async () => {
  const { queue } = buildQueue(1);
  queue.start(buildContext());
  for (let i = 0; i < 40 && queue.snapshot().active.length > 0; i += 1) {
    await sleep(50);
  }

  // peek nao consome
  assert.ok(queue.peekLastQuote("whatsapp", "G1"));
  assert.ok(queue.peekLastQuote("whatsapp", "G1"));

  // primeira confirmacao consome
  assert.ok(queue.consumeForTrade("whatsapp", "G1"));

  // segunda: sem cotacao — precisa cotar de novo
  assert.equal(queue.peekLastQuote("whatsapp", "G1"), null);
  assert.equal(queue.consumeForTrade("whatsapp", "G1"), null);
});

test("fila ativa: confirmacao interrompe a fila", async () => {
  const { queue } = buildQueue(10);
  queue.start(buildContext());
  for (let i = 0; i < 40; i += 1) {
    const active = queue.snapshot().active[0];
    if (active && active.sequence >= 1) break;
    await sleep(50);
  }
  assert.ok(queue.consumeForTrade("whatsapp", "G1"));
  assert.equal(queue.snapshot().active.length, 0, "fila deve ser interrompida");
});

test("grupo sem cotacao alguma: nada a confirmar", () => {
  const { queue } = buildQueue(1);
  assert.equal(queue.consumeForTrade("whatsapp", "G-NUNCA-COTOU"), null);
});

// ---------------------------------------------------------------------------
// Registro de operacao
// ---------------------------------------------------------------------------

test("formatOperationRecord: compra USDT no formato do painel", () => {
  const record = formatOperationRecord({
    groupId: "120363406233321709@g.us",
    transactionId: "0ae8fbb4-0ecb-4ba1-9ea4-10f46ed9a353",
    date: new Date("2026-07-11T20:55:00Z"),
    side: "buy",
    asset: "USDT",
    counterAsset: "BRL",
    quantity: 50_000,
    counterTotal: 250_255,
    unitPrice: 5.0051,
  });

  assert.match(record, /ID do grupo:\n120363406233321709@g\.us/);
  assert.match(record, /ID da Transação:\n0ae8fbb4-0ecb-4ba1-9ea4-10f46ed9a353/);
  assert.match(record, /📅 Data da Operação:\n11\/07\/2026 17:55/); // America/Sao_Paulo
  assert.match(record, /Tipo de Operação:\nCOMPRA USDT/);
  assert.match(record, /Cotação:\n1 USDT = R\$ 5,0051/);
  assert.match(record, /💵 Montante em USDT:\nTotal: 50\.000 USDT\nPendente: 50\.000 USDT/);
  assert.match(record, /💼 Montante em BRL:\nTotal: R\$\s250\.255,00\nPendente: R\$\s250\.255,00/);
});

test("formatOperationRecord: venda USDT", () => {
  const record = formatOperationRecord({
    groupId: "G",
    transactionId: "tx",
    date: new Date("2026-07-11T20:55:00Z"),
    side: "sell",
    asset: "USDT",
    counterAsset: "BRL",
    quantity: 50_000,
    counterTotal: 249_455,
    unitPrice: 4.9891,
  });
  assert.match(record, /Tipo de Operação:\nVENDA USDT/);
  assert.match(record, /💼 Montante em BRL:\nTotal: R\$\s249\.455,00/);
});

test("formatOperationRecord: conversão cripto → cripto", () => {
  const record = formatOperationRecord({
    groupId: "G",
    transactionId: "tx",
    date: new Date("2026-07-11T20:55:00Z"),
    side: "conversion",
    asset: "BTC",
    counterAsset: "USDT",
    quantity: 2,
    counterTotal: 229_680.39,
    unitPrice: 114_840.195,
  });
  assert.match(record, /Tipo de Operação:\nCONVERSÃO BTC → USDT/);
  assert.match(record, /💼 Montante em USDT:\nTotal: 229\.680,39 USDT/);
});
