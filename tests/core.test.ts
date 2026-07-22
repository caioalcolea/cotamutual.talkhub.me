/**
 * Testes das regras de negocio do descritivo:
 *   - normalizacao de ativos (USD/dolar -> USDC)
 *   - classificacao de operacao (tabela definitiva, secao 7)
 *   - interpretacao de comandos (secao 13)
 *   - selecao de fee exata sem fallback (secao 9)
 *   - calculo de fee nas tres direcoes (secoes 10-12)
 *   - toggles: compra SEMPRE desligada por padrao
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeAsset } from "../src/core/assets.js";
import { resolveOperation, UnsupportedOperationError } from "../src/core/operations.js";
import { parseCommand, parseAmount } from "../src/core/parser.js";
import { selectFee, calculateFee, auditMerchantFees, REQUIRED_FEES } from "../src/core/fees.js";
import {
  calculateAssetPurchase,
  calculateBRLToAsset,
  calculateReceiveSide,
} from "../src/core/pricing.js";
import { findMerchantByGroup } from "../src/core/merchants.js";
import { SettingsStore } from "../src/state/settings.js";
import type { MutualFee, MutualMerchant } from "../src/types.js";

// ---------------------------------------------------------------------------
// Normalizacao de ativos
// ---------------------------------------------------------------------------

test("normalizeAsset: USD e dolar viram USDC; aliases de cripto", () => {
  assert.equal(normalizeAsset("usd"), "USDC");
  assert.equal(normalizeAsset("DÓLAR"), "USDC");
  assert.equal(normalizeAsset("dolares"), "USDC");
  assert.equal(normalizeAsset("real"), "BRL");
  assert.equal(normalizeAsset("REAIS"), "BRL");
  assert.equal(normalizeAsset("tether"), "USDT");
  assert.equal(normalizeAsset("bitcoin"), "BTC");
  assert.equal(normalizeAsset("ethereum"), "ETH");
});

// ---------------------------------------------------------------------------
// Classificacao de operacao (tabela definitiva)
// ---------------------------------------------------------------------------

test("resolveOperation: tabela definitiva da secao 7", () => {
  assert.equal(resolveOperation("BRL", "USDT"), "buy");
  assert.equal(resolveOperation("BRL", "BTC"), "buy");
  assert.equal(resolveOperation("BRL", "ETH"), "buy");
  assert.equal(resolveOperation("BRL", "USDC"), "conversion"); // dolar
  assert.equal(resolveOperation("BRL", "USD"), "conversion"); // alias
  assert.equal(resolveOperation("USDC", "BRL"), "conversion");
  assert.equal(resolveOperation("BTC", "USDT"), "conversion");
  assert.equal(resolveOperation("USDT", "BTC"), "conversion");
  assert.equal(resolveOperation("BTC", "BRL"), "sell");
  assert.equal(resolveOperation("USDT", "BRL"), "sell");
  assert.throws(() => resolveOperation("XYZ", "BRL"), UnsupportedOperationError);
});

// ---------------------------------------------------------------------------
// Parser de comandos
// ---------------------------------------------------------------------------

test("parseAmount: sufixos K/M e formatos pt-BR", () => {
  assert.equal(parseAmount("25K"), 25_000);
  assert.equal(parseAmount("1,5m"), 1_500_000);
  assert.equal(parseAmount("5.000,50"), 5000.5);
  assert.equal(parseAmount("5.000"), 5000);
  assert.equal(parseAmount("0.5"), 0.5);
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount("-10"), null);
});

test("parseCommand: tabela de resultados esperados da secao 13", () => {
  const cases: Array<[string, string, string, "source" | "destination", number]> = [
    ["/REF 25K USDT", "BRL", "USDT", "destination", 25_000],
    ["/COTAR 5000 BRL USDT", "BRL", "USDT", "source", 5000],
    ["/COTAR 5000 BRL USD", "BRL", "USDC", "source", 5000],
    ["/COTAR 25000 USDC BRL", "USDC", "BRL", "source", 25_000],
    ["/COTAR 1 BTC USDT", "BTC", "USDT", "source", 1],
    ["/COTAR 1 BTC BRL", "BTC", "BRL", "source", 1],
  ];
  for (const [raw, source, dest, amountKind, amount] of cases) {
    const parsed = parseCommand(raw);
    assert.ok(parsed && parsed.kind === "quote", `esperava quote para ${raw}`);
    assert.equal(parsed.sourceAsset, source, raw);
    assert.equal(parsed.destinationAsset, dest, raw);
    assert.equal(parsed.amountKind, amountKind, raw);
    assert.equal(parsed.amount, amount, raw);
  }
});

test("parseCommand: comandos de compra, venda, ajuda e ignorados", () => {
  assert.equal(parseCommand("/COMPRAR")?.kind, "buy");
  assert.equal(parseCommand("/order")?.kind, "buy");
  assert.equal(parseCommand("/AJUDA")?.kind, "help");
  const sell = parseCommand("/VENDER 1 BTC");
  assert.ok(sell && sell.kind === "quote");
  assert.equal(sell.sourceAsset, "BTC");
  assert.equal(sell.destinationAsset, "BRL");
  // Mensagens sem "/" e comandos desconhecidos sao ignorados.
  assert.equal(parseCommand("bom dia"), null);
  assert.equal(parseCommand("/qualquercoisa 123"), null);
  // Comando de cotacao sem argumentos validos vira "invalid".
  assert.equal(parseCommand("/COTAR")?.kind, "invalid");
  assert.equal(parseCommand("/COTAR abc USDT")?.kind, "invalid");
});

// ---------------------------------------------------------------------------
// Selecao e calculo de fee
// ---------------------------------------------------------------------------

const FEES: MutualFee[] = [
  { id: "fee_1", operation: "buy", sourceAsset: "BRL", destinationAsset: "USDT", feeFixed: 0.0001, feePercentage: 0.0001 },
  { id: "fee_2", operation: "sell", sourceAsset: "BTC", destinationAsset: "BRL", feeFixed: 10, feePercentage: 0.01 },
];

test("selectFee: combinacao exata, sem fallback silencioso", () => {
  assert.equal(selectFee(FEES, "buy", "BRL", "USDT")?.id, "fee_1");
  // Fee de BRL->USDT NAO pode ser usada em BRL->BTC.
  assert.equal(selectFee(FEES, "buy", "BRL", "BTC"), null);
  assert.equal(selectFee(FEES, "conversion", "BRL", "USDT"), null);
});

test("calculateFee: fixa e percentual sao AMBAS pontos percentuais que se somam", () => {
  // fixa 0.1% + percentual 0.65% = 0,75% do valor-base
  const fee: MutualFee = { id: "f", feeFixed: 0.1, feePercentage: 0.65 };
  const calc = calculateFee(10_000, fee);
  assert.ok(Math.abs(calc.feeRate - 0.0075) < 1e-12);
  assert.ok(Math.abs(calc.feePercentageValue - 65) < 1e-9);
  assert.ok(Math.abs(calc.feeFixedValue - 10) < 1e-9);
  assert.ok(Math.abs(calc.feeTotalValue - 75) < 1e-9);
  assert.throws(() => calculateFee(0, fee));
});

test("calculateAssetPurchase: caso real VIZZO — 0,65% NAO pode virar 65%", () => {
  // Bug de producao: 1 USDT @ 5,0781 com fee 0.65 saia R$ 8,38 (fee tratada
  // como fracao). Correto: 5,0781 × 1,0065 = R$ 5,11111.
  const fee: MutualFee = { id: "f", feeFixed: 0, feePercentage: 0.65 };
  const r = calculateAssetPurchase({ quantity: 1, baseUnitPrice: 5.0781, fee });
  assert.ok(Math.abs(r.finalTotal - 5.11111) < 1e-4);
  assert.ok(r.finalTotal < 5.2, "fee de 0,65% jamais pode dobrar o preço");
});

test("calculateAssetPurchase: fee somada em cima do total", () => {
  // fixa 0.0001% + percentual 0.0001% = 0,0002%
  const fee: MutualFee = { id: "f", feeFixed: 0.0001, feePercentage: 0.0001 };
  const r = calculateAssetPurchase({ quantity: 25_000, baseUnitPrice: 5.3, fee });
  assert.ok(Math.abs(r.finalTotal - 132_500.265) < 1e-6);
});

test("calculateBRLToAsset: fee sai de dentro do orcamento", () => {
  // fixa 0.35% + percentual 0.65% = 1%
  const fee: MutualFee = { id: "f", feeFixed: 0.35, feePercentage: 0.65 };
  const r = calculateBRLToAsset({ amountBRL: 5050, baseUnitPrice: 5, fee });
  // baseAvailable = 5050 / 1.01 = 5000
  assert.ok(Math.abs(r.baseAvailable - 5000) < 1e-9);
  assert.ok(Math.abs(r.quantity - 1000) < 1e-9);
  // baseAvailable + feeTotal esgota exatamente o orcamento
  assert.ok(Math.abs(r.baseAvailable + r.feeTotalValue - 5050) < 1e-9);
});

test("calculateReceiveSide: venda recebe o bruto menos a taxa total", () => {
  // fixa 0.5% + percentual 0.5% = 1%
  const fee: MutualFee = { id: "f", feeFixed: 0.5, feePercentage: 0.5 };
  const r = calculateReceiveSide({ quantity: 1, baseUnitPrice: 600_000, fee });
  assert.equal(r.grossAmount, 600_000);
  assert.ok(Math.abs(r.netAmount - 594_000) < 1e-9);
});

test("auditMerchantFees: aponta pares ausentes da matriz minima", () => {
  const audit = auditMerchantFees(FEES);
  assert.equal(audit.length, REQUIRED_FEES.length);
  const buyUsdt = audit.find((a) => a.operation === "buy" && a.destinationAsset === "USDT");
  assert.equal(buyUsdt?.configured, true);
  const buyBtc = audit.find((a) => a.operation === "buy" && a.destinationAsset === "BTC");
  assert.equal(buyBtc?.configured, false);
});

// ---------------------------------------------------------------------------
// Merchant por grupo
// ---------------------------------------------------------------------------

const MERCHANTS: MutualMerchant[] = [
  {
    id: "org_1",
    status: "active",
    legalName: "Cliente A",
    linkGroups: [{ id: "lg_1", channel: "whatsapp", groupId: "G1", active: true }],
  },
  {
    id: "org_2",
    status: "inactive",
    legalName: "Cliente B",
    linkGroups: [{ id: "lg_2", channel: "whatsapp", groupId: "G2", active: true }],
  },
  {
    id: "org_3",
    status: "active",
    legalName: "Cliente C",
    linkGroups: [{ id: "lg_3", channel: "whatsapp", groupId: "G3", active: false }],
  },
];

test("findMerchantByGroup: exige merchant ativo e linkGroup ativo", () => {
  assert.equal(findMerchantByGroup(MERCHANTS, "WhatsApp", " G1 ")?.id, "org_1");
  assert.equal(findMerchantByGroup(MERCHANTS, "whatsapp", "G2"), undefined); // merchant inativo
  assert.equal(findMerchantByGroup(MERCHANTS, "whatsapp", "G3"), undefined); // grupo inativo
  assert.equal(findMerchantByGroup(MERCHANTS, "telegram", "G1"), undefined); // canal errado
});

// ---------------------------------------------------------------------------
// Toggles do painel
// ---------------------------------------------------------------------------

test("SettingsStore: compra SEMPRE desligada por padrao; cotacoes ligadas", () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-test-"));
  const store = new SettingsStore(dir);

  const effective = store.getEffective("whatsapp", "G1");
  assert.equal(effective.quotes, true);
  assert.equal(effective.buy, false);
  assert.equal(effective.buySource, "default");

  // Ativacao manual (painel) por grupo.
  store.setGroupToggle("whatsapp", "G1", "buy", true);
  assert.equal(store.getEffective("whatsapp", "G1").buy, true);
  // Outros grupos continuam desligados.
  assert.equal(store.getEffective("whatsapp", "G2").buy, false);

  // Override de canal nao afeta grupo com override proprio.
  store.setChannelToggle("whatsapp", "quotes", false);
  assert.equal(store.getEffective("whatsapp", "G2").quotes, false);
  store.setGroupToggle("whatsapp", "G2", "quotes", true);
  assert.equal(store.getEffective("whatsapp", "G2").quotes, true);

  // Persistencia: nova instancia le o mesmo estado.
  const reloaded = new SettingsStore(dir);
  assert.equal(reloaded.getEffective("whatsapp", "G1").buy, true);
});

test("parseCommand: argumentos do /COMPRAR sao lidos", () => {
  const bare = parseCommand("/COMPRAR");
  assert.ok(bare && bare.kind === "buy" && !bare.argsPresent && bare.argsValid);

  const withAll = parseCommand("/comprar 1k btc");
  assert.ok(withAll && withAll.kind === "buy");
  assert.equal(withAll.argsPresent, true);
  assert.equal(withAll.argsValid, true);
  assert.equal(withAll.amount, 1000);
  assert.equal(withAll.asset, "BTC");

  const assetOnly = parseCommand("/comprar usdt");
  assert.ok(assetOnly && assetOnly.kind === "buy" && assetOnly.asset === "USDT");

  const amountOnly = parseCommand("/comprar 100k");
  assert.ok(amountOnly && amountOnly.kind === "buy" && amountOnly.amount === 100_000);

  const garbage = parseCommand("/comprar tudo agora");
  assert.ok(garbage && garbage.kind === "buy" && garbage.argsPresent && !garbage.argsValid);
});
