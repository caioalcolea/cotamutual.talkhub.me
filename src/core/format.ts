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
      // Quantidade 1: usa a formatacao de preco unitario (mais casas decimais).
      `${formatQty(result.quantity)} ${destinationAsset} = ${
        result.quantity === 1 ? formatUnitBRL(result.finalTotal) : formatBRL(result.finalTotal)
      }`,
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
      `${formatQty(result.quantity)} ${sourceAsset} = ${
        result.quantity === 1 ? formatUnitBRL(result.netAmount) : formatBRL(result.netAmount)
      }`,
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
// Registro de operacao (emitido pelo /COMPRAR na fase de operacao manual)
// ---------------------------------------------------------------------------

export interface OperationRecordParams {
  groupId: string;
  transactionId: string;
  date: Date;
  operation: string; // buy | sell | conversion
  sourceAsset: string;
  destinationAsset: string;
  result: QuoteCalculation;
}

function operationTypeLabel(operation: string, sourceAsset: string, destinationAsset: string): string {
  if (operation === "buy") return `COMPRA ${destinationAsset}`;
  if (operation === "sell") return `VENDA ${sourceAsset}`;
  return `CONVERSÃO ${sourceAsset} → ${destinationAsset}`;
}

/**
 * Registro completo da operacao no formato do painel da Mutual:
 * ID do grupo, ID da transacao, data, tipo, cotacao e montantes Total/Pendente.
 * "Pendente" = valor integral, pois a conclusao e manual nesta fase.
 */
export function formatOperationRecord(params: OperationRecordParams): string {
  const { groupId, transactionId, date, operation, sourceAsset, destinationAsset, result } = params;

  const dateStr = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(date)
    .replace(",", "");

  const lines: string[] = [
    "ID do grupo:",
    groupId,
    "",
    "ID da Transação:",
    transactionId,
    "",
    "📅 Data da Operação:",
    dateStr,
    "",
    "Tipo de Operação:",
    operationTypeLabel(operation, sourceAsset, destinationAsset),
    "",
  ];

  if (result.kind === "asset-purchase" || result.kind === "brl-budget") {
    const qty = result.quantity;
    const brl = result.kind === "asset-purchase" ? result.finalTotal : result.amountBRL;
    lines.push(
      "Cotação:",
      `1 ${destinationAsset} = ${formatUnitBRL(result.finalUnitPrice)}`,
      "",
      `💵 Montante em ${destinationAsset}:`,
      `Total: ${formatQty(qty)} ${destinationAsset}`,
      `Pendente: ${formatQty(qty)} ${destinationAsset}`,
      "",
      "💼 Montante em BRL:",
      `Total: ${formatBRL(brl)}`,
      `Pendente: ${formatBRL(brl)}`,
    );
  } else if (destinationAsset === "BRL") {
    lines.push(
      "Cotação:",
      `1 ${sourceAsset} = ${formatUnitBRL(result.finalUnitPrice)}`,
      "",
      `💵 Montante em ${sourceAsset}:`,
      `Total: ${formatQty(result.quantity)} ${sourceAsset}`,
      `Pendente: ${formatQty(result.quantity)} ${sourceAsset}`,
      "",
      "💼 Montante em BRL:",
      `Total: ${formatBRL(result.netAmount)}`,
      `Pendente: ${formatBRL(result.netAmount)}`,
    );
  } else {
    lines.push(
      "Cotação:",
      `1 ${sourceAsset} = ${formatQty(result.finalUnitPrice)} ${destinationAsset}`,
      "",
      `💵 Montante em ${sourceAsset}:`,
      `Total: ${formatQty(result.quantity)} ${sourceAsset}`,
      `Pendente: ${formatQty(result.quantity)} ${sourceAsset}`,
      "",
      `💼 Montante em ${destinationAsset}:`,
      `Total: ${formatQty(result.netAmount)} ${destinationAsset}`,
      `Pendente: ${formatQty(result.netAmount)} ${destinationAsset}`,
    );
  }

  return lines.join("\n");
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

  // Encerramento padrao da compra manual: NUNCA citar bot/estado.
  manualClosing:
    "A operação será concluída manualmente por um operador da Mutual. Aguarde a confirmação aqui no grupo. 🤝",

  // Compra ativada no painel, mas fase de ordens ainda desabilitada (secao 16).
  ordersNotEnabledClosing:
    "ℹ️ A execução automática de ordens ainda não está habilitada.\nA operação será concluída manualmente por um operador da Mutual. Aguarde a confirmação aqui no grupo.",

  // Compra com registro completo da operacao (quando ha cotacao recente).
  buyWithRecord: (record: string, closing: string): string =>
    `✅ Pedido recebido!\n\n${record}\n\n${closing}`,

  // Compra sem cotacao valida no grupo (nenhuma, expirada ou ja consumida
  // por um /COMPRAR anterior): exige cotacao atualizada antes de confirmar.
  buyNeedQuote: [
    "ℹ️ Para confirmar a operação é preciso uma cotação atualizada — os preços mudam a cada segundo e cada cotação vale para uma única confirmação.",
    "Envie /COTAR (ex: /COTAR 25K USDT) e confirme com /COMPRAR em seguida.",
  ].join("\n"),

  // /COMPRAR com argumentos que nao batem com a cotacao ativa.
  buyMismatch: (activeSummary: string | null, requested: string): string =>
    [
      activeSummary
        ? `⚠️ A cotação ativa é: ${activeSummary}`
        : "⚠️ Não há cotação ativa para esse pedido.",
      `Para operar ${requested}, gere uma cotação atualizada: envie /COTAR ${requested} e confirme com /COMPRAR.`,
    ].join("\n"),

  // /COMPRAR com argumentos incompreensiveis.
  buyArgsNotUnderstood: (activeSummary: string | null): string =>
    [
      "⚠️ Não entendi os detalhes do pedido.",
      activeSummary ? `A cotação ativa é: ${activeSummary}` : null,
      "Envie /COMPRAR (sem argumentos) para confirmar a cotação ativa, ou /COTAR <valor> <ativo> para uma nova cotação.",
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
