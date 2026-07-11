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
import { calculateAssetPurchase } from "../src/core/pricing.js";
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

  const summary = queue.interruptForBuy("whatsapp", "G1");
  assert.ok(summary, "resumo da ultima cotacao deveria sobreviver ao fim da fila");
  assert.match(summary as string, /10\.000 USDT = R\$/);
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

  const summary = queue.interruptForBuy("whatsapp", "G1");
  assert.ok(summary);
  assert.equal(queue.snapshot().active.length, 0, "fila deve ser interrompida");
});

test("grupo sem cotacao alguma: /COMPRAR sem resumo", () => {
  const { queue } = buildQueue(1);
  assert.equal(queue.interruptForBuy("whatsapp", "G-NUNCA-COTOU"), null);
});
