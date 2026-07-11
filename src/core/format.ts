/**
 * Formatacao das respostas enviadas ao grupo (secao 14 do descritivo).
 *
 * Por padrao o grupo NUNCA ve: feePercentage, feeFixed, preco-base sem fee,
 * merchantId ou detalhes internos. Apenas a cotacao final.
 *
 * IMPORTANTE (regra do produto): nenhuma mensagem cita "bot ligado/desligado".
 * Quando um recurso nao esta ativo, a mensagem informa apenas que a operacao
 * sera concluida manualmente por um operador da Mutual.
 */

import type { QuoteCalculation } from "./pricing.js";

const brl2 = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatBRL(value: number): string {
  return brl2.format(value);
}

/** Preco unitario em BRL com mais casas (ex: R$ 5,30063). */
export function formatUnitBRL(value: number): string {
  const decimals = value >= 100 ? 2 : value >= 1 ? 5 : 8;
  const formatted = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  }).format(value);
  return `R$ ${formatted}`;
}

/** Quantidade de ativo (ate 8 casas, sem zeros inuteis). */
export function formatQty(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
  }).format(value);
}

export interface QuoteMessageContext {
  sourceAsset: string;
  destinationAsset: string;
  sequence: number;
  total: number;
  result: QuoteCalculation;
}

/** Mensagem de cotacao enviada ao grupo (uma por posicao da fila). */
export function formatQuoteMessage(ctx: QuoteMessageContext): string {
  const { sourceAsset, destinationAsset, sequence, total, result } = ctx;
  const header = `📊 Cotação ${sourceAsset} → ${destinationAsset} (${sequence}/${total})`;

  if (result.kind === "asset-purchase") {
    return [
      header,
      `${formatQty(result.quantity)} ${destinationAsset} = ${formatBRL(result.finalTotal)}`,
      result.quantity !== 1 ? `1 ${destinationAsset} = ${formatUnitBRL(result.finalUnitPrice)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "brl-budget") {
    return [
      header,
      `${formatBRL(result.amountBRL)} = ${formatQty(result.quantity)} ${destinationAsset}`,
      `1 ${destinationAsset} = ${formatUnitBRL(result.finalUnitPrice)}`,
    ].join("\n");
  }

  // receive-side: venda para BRL ou conversao com recebimento no destino.
  if (destinationAsset === "BRL") {
    return [
      header,
      `${formatQty(result.quantity)} ${sourceAsset} = ${formatBRL(result.netAmount)}`,
      result.quantity !== 1 ? `1 ${sourceAsset} = ${formatUnitBRL(result.finalUnitPrice)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    header,
    `${formatQty(result.quantity)} ${sourceAsset} = ${formatQty(result.netAmount)} ${destinationAsset}`,
    result.quantity !== 1
      ? `1 ${sourceAsset} = ${formatQty(result.finalUnitPrice)} ${destinationAsset}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Resumo curto da ultima cotacao (usado na mensagem de encerramento por compra). */
export function formatQuoteSummary(ctx: Omit<QuoteMessageContext, "sequence" | "total">): string {
  const { sourceAsset, destinationAsset, result } = ctx;
  if (result.kind === "asset-purchase") {
    return `${formatQty(result.quantity)} ${destinationAsset} = ${formatBRL(result.finalTotal)}`;
  }
  if (result.kind === "brl-budget") {
    return `${formatBRL(result.amountBRL)} = ${formatQty(result.quantity)} ${destinationAsset}`;
  }
  if (destinationAsset === "BRL") {
    return `${formatQty(result.quantity)} ${sourceAsset} = ${formatBRL(result.netAmount)}`;
  }
  return `${formatQty(result.quantity)} ${sourceAsset} = ${formatQty(result.netAmount)} ${destinationAsset}`;
}

// ---------------------------------------------------------------------------
// Textos padrao
// ---------------------------------------------------------------------------

export const MESSAGES = {
  groupNotLinked:
    "⚠️ Este grupo ainda não está vinculado a um cliente habilitado para cotações.",

  feeNotConfigured:
    "⚠️ Não há taxa configurada para esta operação neste cliente.",

  unsupportedOperation: (source: string, destination: string): string =>
    `⚠️ Operação não suportada: ${source} → ${destination}.`,

  quoteFailed:
    "⚠️ Não foi possível gerar a cotação agora. Tente novamente em instantes.",

  // Cotacoes tratadas manualmente (recurso de cotacao inativo no painel).
  quotesManual:
    "📩 Solicitação recebida! Esta cotação será conduzida manualmente por um operador da Mutual. Aguarde o retorno aqui no grupo.",

  // Compra com execucao automatica inativa (padrao): NUNCA citar bot/estado.
  buyManual: (lastQuote: string | null): string =>
    [
      "✅ Pedido recebido!",
      lastQuote ? `🔒 Última cotação registrada: ${lastQuote}` : null,
      "A operação será concluída manualmente por um operador da Mutual. Aguarde a confirmação aqui no grupo. 🤝",
    ]
      .filter(Boolean)
      .join("\n"),

  // Compra ativada no painel, mas fase de ordens ainda desabilitada (secao 16).
  ordersNotEnabled: (lastQuote: string | null): string =>
    [
      "ℹ️ A execução automática de ordens ainda não está habilitada.",
      lastQuote ? `🔒 Última cotação registrada: ${lastQuote}` : null,
      "A operação será concluída manualmente por um operador da Mutual. Aguarde a confirmação aqui no grupo.",
    ]
      .filter(Boolean)
      .join("\n"),

  queueFinished: (total: number): string =>
    `✅ Fila de cotações concluída (${total} atualizações de preço). Envie /COTAR para uma nova cotação ou /COMPRAR para fechar a operação.`,

  usageQuote: [
    "ℹ️ Formatos aceitos:",
    "/COTAR 25K USDT — comprar 25.000 USDT com BRL",
    "/COTAR 5000 BRL USDT — usar R$ 5.000,00 de orçamento",
    "/COTAR 1 BTC BRL — vender 1 BTC para BRL",
    "/COTAR 1 BTC USDT — converter entre criptoativos",
  ].join("\n"),

  usageSell: "ℹ️ Formato: /VENDER <quantidade> <ativo> — ex: /VENDER 1 BTC",

  unknownAsset:
    "⚠️ Ativo não reconhecido. Ativos disponíveis: BRL, BTC, ETH, USDT, USDC (USD/dólar = USDC).",

  help: [
    "🤖 Comandos disponíveis:",
    "/COTAR 25K USDT — cotação para comprar 25.000 USDT com BRL",
    "/COTAR 5000 BRL USDT — cotação usando R$ 5.000,00 como orçamento",
    "/COTAR 5000 BRL USD — câmbio BRL → dólar (USDC)",
    "/COTAR 1 BTC BRL — venda de 1 BTC para BRL",
    "/COTAR 1 BTC USDT — conversão entre criptoativos",
    "/REF 25K USDT — atalho equivalente ao /COTAR",
    "/COMPRAR — encerra a fila de cotações e inicia a operação",
    "",
    "Cada cotação envia uma sequência de atualizações de preço em tempo real.",
  ].join("\n"),
} as const;
