/**
 * Testes da fila de cotacoes: a ultima cotacao do grupo deve continuar
 * disponivel para o /COMPRAR mesmo depois de a fila terminar (10/10).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { QuoteQueue } from "../src/queue/quote-queue.js";
import { QuoteLogRepository } from "../src/state/quote-log.js";
import { calculateAssetPurchase, calculateReceiveSide } from "../src/core/pricing.js";
import type { QuoteEngine, QuoteContext } from "../src/core/engine.js";
import type { OutboundSender } from "../src/channels/outbound.js";

function buildContext(): QuoteContext {
  return {
    channel: "whatsapp",
    groupId: "G1",
    merchant: { id: "org_1", status: "active", legalName: "Cliente" },
    operation: "buy",
    sourceAsset: "BRL",
    destinationAsset: "USDT",
    amount: 10_000,
    amountKind: "destination",
    fee: { id: "fee_1", feeFixed: 0.0001, feePercentage: 0.0001 },
    command: "/COTAR 10K USDT",
  } as QuoteContext;
}

function buildQueue(totalMessages: number) {
  const sent: string[] = [];
  const engine = {
    tick: async (ctx: QuoteContext) => ({
      result: calculateAssetPurchase({ quantity: ctx.amount, baseUnitPrice: 5.1631, fee: ctx.fee }),
      basePrice: 5.1631,
      rawTickers: [],
      priceSources: ["ticker"],
    }),
  } as unknown as QuoteEngine;
  const outbound = {
    send: async (m: { text: string }) => {
      sent.push(m.text);
      return true;
    },
  } as unknown as OutboundSender;
  const quoteLog = new QuoteLogRepository(mkdtempSync(join(tmpdir(), "cotamutual-queue-")));
  return { queue: new QuoteQueue(engine, outbound, quoteLog, totalMessages, 600), sent };
}

test("fila concluida: /COMPRAR ainda recupera a ultima cotacao (TTL)", async () => {
  const { queue, sent } = buildQueue(1);
  queue.start(buildContext());

  // Espera a fila de 1 mensagem terminar por completo.
  for (let i = 0; i < 40 && queue.snapshot().active.length > 0; i += 1) {
    await sleep(50);
  }
  assert.equal(queue.snapshot().active.length, 0);
  assert.ok(sent.some((t) => t.startsWith("📊")));

  const last = queue.interruptForBuy("whatsapp", "G1");
  assert.ok(last, "ultima cotacao deveria sobreviver ao fim da fila");
  assert.match(last.summary, /10\.000 USDT = R\$/);
  assert.equal(last.operation, "buy");
  assert.equal(last.destinationAsset, "USDT");
  assert.equal(last.result.kind, "asset-purchase");
});

test("fila ativa: /COMPRAR interrompe e usa a cotacao da propria fila", async () => {
  const { queue } = buildQueue(10);
  queue.start(buildContext());

  // Espera a primeira mensagem sair (fila continua ativa).
  for (let i = 0; i < 40; i += 1) {
    const active = queue.snapshot().active[0];
    if (active && active.sequence >= 1) break;
    await sleep(50);
  }

  const last = queue.interruptForBuy("whatsapp", "G1");
  assert.ok(last);
  assert.equal(queue.snapshot().active.length, 0, "fila deve ser interrompida");
});

test("grupo sem cotacao alguma: /COMPRAR sem resumo", () => {
  const { queue } = buildQueue(1);
  assert.equal(queue.interruptForBuy("whatsapp", "G-NUNCA-COTOU"), null);
});

// ---------------------------------------------------------------------------
// Registro de operacao do /COMPRAR (formato do painel da Mutual)
// ---------------------------------------------------------------------------

import { formatOperationRecord } from "../src/core/format.js";

test("formatOperationRecord: compra USDT no formato do template", () => {
  const result = calculateAssetPurchase({
    quantity: 1000,
    baseUnitPrice: 5.1631,
    fee: { id: "f", feeFixed: 0.0001, feePercentage: 0.0001 },
  });
  const record = formatOperationRecord({
    groupId: "120363406233321709@g.us",
    transactionId: "0ae8fbb4-0ecb-4ba1-9ea4-10f46ed9a353",
    date: new Date("2026-07-11T20:55:00Z"),
    operation: "buy",
    sourceAsset: "BRL",
    destinationAsset: "USDT",
    result,
  });

  assert.match(record, /ID do grupo:\n120363406233321709@g\.us/);
  assert.match(record, /ID da Transação:\n0ae8fbb4-0ecb-4ba1-9ea4-10f46ed9a353/);
  assert.match(record, /📅 Data da Operação:\n11\/07\/2026 17:55/); // America/Sao_Paulo
  assert.match(record, /Tipo de Operação:\nCOMPRA USDT/);
  assert.match(record, /Cotação:\n1 USDT = R\$ 5,16362/);
  assert.match(record, /💵 Montante em USDT:\nTotal: 1\.000 USDT\nPendente: 1\.000 USDT/);
  // Intl pt-BR usa espaco nao separavel (U+00A0) apos "R$"
  assert.match(record, /💼 Montante em BRL:\nTotal: R\$[\s ]5\.163,62\nPendente: R\$[\s ]5\.163,62/);
});

test("formatOperationRecord: venda BTC mostra montante liquido em BRL", () => {
  const result = calculateReceiveSide({
    quantity: 1,
    baseUnitPrice: 600_000,
    fee: { id: "f", feeFixed: 10, feePercentage: 0.01 },
  });
  const record = formatOperationRecord({
    groupId: "G",
    transactionId: "tx",
    date: new Date("2026-07-11T20:55:00Z"),
    operation: "sell",
    sourceAsset: "BTC",
    destinationAsset: "BRL",
    result,
  });
  assert.match(record, /Tipo de Operação:\nVENDA BTC/);
  assert.match(record, /💵 Montante em BTC:\nTotal: 1 BTC/);
  assert.match(record, /💼 Montante em BRL:\nTotal: R\$[\s ]593\.990,00/);
});

test("cotacao e CONSUMIDA pelo /COMPRAR: segunda confirmacao exige cotacao nova", async () => {
  const { queue } = buildQueue(1);
  queue.start(buildContext());
  for (let i = 0; i < 40 && queue.snapshot().active.length > 0; i += 1) {
    await sleep(50);
  }

  // peek nao consome
  assert.ok(queue.peekLastQuote("whatsapp", "G1"));
  assert.ok(queue.peekLastQuote("whatsapp", "G1"));

  // primeira compra consome
  const first = queue.interruptForBuy("whatsapp", "G1");
  assert.ok(first);

  // segunda compra: sem cotacao — precisa cotar de novo
  assert.equal(queue.peekLastQuote("whatsapp", "G1"), null);
  assert.equal(queue.interruptForBuy("whatsapp", "G1"), null);
});
