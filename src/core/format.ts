/**
 * Formatacao das respostas enviadas ao grupo.
 *
 * Formato da cotacao (mesa OTC — os dois lados na mesma mensagem):
 *
 *   💱 Cotação · USDT D0 • 🇧🇷 USDT/BRL · 3/10
 *
 *   🟢 Compra: 1 USDT = R$ 5,0051
 *   50k USDT = R$ 250.255,00
 *   🔴 Venda: 1 USDT = R$ 4,9891
 *   50k USDT = R$ 249.455,00
 *   🧾 Digite
 *   → /compra 50k USDT
 *   → /venda 50k USDT
 *
 *   ⚡ Valores sujeitos à confirmação no fechamento.
 *
 * O grupo NUNCA ve feePercentage, feeFixed, preco-base sem fee, merchantId ou
 * detalhes internos — apenas os precos finais.
 *
 * BLINDAGEM: um lado sem fee cadastrada (ou com preco invalido) sai como
 * "sob consulta" e o comando daquele lado nao e oferecido — nunca um numero
 * errado. Nenhuma mensagem cita "bot ligado/desligado": recursos inativos
 * informam apenas que a operacao sera concluida manualmente pela Mutual.
 */

import type { SideQuote } from "./engine.js";
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

/**
 * Preco unitario em BRL no padrao da mesa (ex: R$ 5,0051):
 * 4 casas para precos correntes, 2 para precos altos, 8 para fracionarios.
 */
export function formatUnitBRL(value: number): string {
  const decimals = value >= 100 ? 2 : value >= 1 ? 4 : 8;
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

/**
 * Quantidade para exibicao no grupo: casas proporcionais a magnitude
 * (998,98 USDT · 0,00123456 BTC) — evita numeros ilegiveis quando a
 * quantidade e derivada de um orcamento em BRL.
 */
export function formatQtyDisplay(value: number): string {
  const decimals = value >= 100 ? 2 : value >= 1 ? 6 : 8;
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value);
}

// --- Dolar: pronto para uso futuro (bloco desligado nesta fase) -------------

const usd2 = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUSD(value: number): string {
  return usd2.format(value);
}

export function formatUnitUSD(value: number): string {
  const decimals = value >= 100 ? 2 : value >= 0.1 ? 5 : 8;
  const formatted = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  }).format(value);
  return `US$ ${formatted}`;
}

// ---------------------------------------------------------------------------
// Cotacao do par (dois lados)
// ---------------------------------------------------------------------------

export interface PairQuoteMessageContext {
  asset: string;
  sizeKind: "asset" | "brl";
  /** Valor como digitado pelo cliente (ex: "50k") — usado nas linhas e dicas. */
  amountRaw: string;
  amount: number;
  buy: SideQuote | null;
  sell: SideQuote | null;
  sequence: number;
  total: number;
  /** Rotulo de liquidacao exibido no cabecalho (ex: "D0"). */
  settlementLabel: string;
  /** Cotacao do dolar — quando presente, adiciona o bloco em USD. */
  usdRateBRL?: number | null;
}

/** Linha do tamanho negociado, por lado. */
function sizeLine(ctx: PairQuoteMessageContext, side: SideQuote): string | null {
  if (ctx.sizeKind === "brl") {
    // Compra: paga R$ X e recebe Y. Venda: entrega Y e recebe R$ X.
    return side.side === "buy"
      ? `${formatBRL(side.totalBRL)} = ${formatQtyDisplay(side.quantity)} ${ctx.asset}`
      : `${formatQtyDisplay(side.quantity)} ${ctx.asset} = ${formatBRL(side.totalBRL)}`;
  }
  // Quantidade 1: a linha do tamanho repetiria o preco unitario.
  if (ctx.amount === 1) return null;
  return `${ctx.amountRaw} ${ctx.asset} = ${formatBRL(side.totalBRL)}`;
}

function sideBlock(
  ctx: PairQuoteMessageContext,
  label: string,
  emoji: string,
  side: SideQuote | null,
): string[] {
  if (!side) return [`${emoji} ${label}: ${MESSAGES.sideUnavailable}`];
  const lines = [`${emoji} ${label}: 1 ${ctx.asset} = ${formatUnitBRL(side.unitPrice)}`];
  const size = sizeLine(ctx, side);
  if (size) lines.push(size);
  return lines;
}

export function formatPairQuoteMessage(ctx: PairQuoteMessageContext): string {
  const sizeArgs =
    ctx.sizeKind === "brl" ? `${ctx.amountRaw} BRL ${ctx.asset}` : `${ctx.amountRaw} ${ctx.asset}`;

  const lines: string[] = [
    `💱 Cotação · ${ctx.asset} ${ctx.settlementLabel} • 🇧🇷 ${ctx.asset}/BRL · ${ctx.sequence}/${ctx.total}`,
    "",
    ...sideBlock(ctx, "Compra", "🟢", ctx.buy),
    ...sideBlock(ctx, "Venda", "🔴", ctx.sell),
  ];

  // Bloco em dolar (desligado nesta fase; mantido para uso futuro).
  const usd = Number(ctx.usdRateBRL);
  if (Number.isFinite(usd) && usd > 0) {
    if (ctx.buy) lines.push(`💵 Compra: 1 ${ctx.asset} = ${formatUnitUSD(ctx.buy.unitPrice / usd)}`);
    if (ctx.sell) lines.push(`💵 Venda: 1 ${ctx.asset} = ${formatUnitUSD(ctx.sell.unitPrice / usd)}`);
  }

  lines.push("🧾 Digite");
  if (ctx.buy) lines.push(`→ /compra ${sizeArgs}`);
  if (ctx.sell) lines.push(`→ /venda ${sizeArgs}`);

  lines.push("", "⚡ Valores sujeitos à confirmação no fechamento.");

  // Aviso honesto quando um dos lados nao esta disponivel.
  if (!ctx.buy || !ctx.sell) {
    const missing = !ctx.buy ? "compra" : "venda";
    lines.push(`ℹ️ A ${missing} deste par será conduzida manualmente por um operador da Mutual.`);
  }

  return lines.join("\n");
}

/** Cotacao cripto -> cripto (sem perna em BRL): direcao unica. */
export interface CrossQuoteMessageContext {
  sourceAsset: string;
  destinationAsset: string;
  amountRaw: string;
  amount: number;
  result: QuoteCalculation;
  sequence: number;
  total: number;
  settlementLabel: string;
}

export function formatCrossQuoteMessage(ctx: CrossQuoteMessageContext): string {
  const { sourceAsset, destinationAsset, result } = ctx;
  const unit = result.finalUnitPrice;
  const totalOut = result.kind === "receive-side" ? result.netAmount : 0;

  const lines = [
    `💱 Cotação · ${sourceAsset} ${ctx.settlementLabel} • ${sourceAsset}/${destinationAsset} · ${ctx.sequence}/${ctx.total}`,
    "",
    `🔁 Conversão: 1 ${sourceAsset} = ${formatQty(unit)} ${destinationAsset}`,
  ];
  if (ctx.amount !== 1) {
    lines.push(`${ctx.amountRaw} ${sourceAsset} = ${formatQty(totalOut)} ${destinationAsset}`);
  }
  lines.push(
    "🧾 Digite",
    `→ /compra ${ctx.amountRaw} ${sourceAsset} ${destinationAsset}`,
    "",
    "⚡ Valores sujeitos à confirmação no fechamento.",
  );
  return lines.join("\n");
}

/** Resumo curto da ultima cotacao (painel e logs). */
export function formatPairSummary(ctx: {
  asset: string;
  amountRaw: string;
  sizeKind: "asset" | "brl";
  buy: SideQuote | null;
  sell: SideQuote | null;
}): string {
  const size = ctx.sizeKind === "brl" ? `${ctx.amountRaw} BRL` : `${ctx.amountRaw} ${ctx.asset}`;
  const parts = [
    ctx.buy ? `compra ${formatUnitBRL(ctx.buy.unitPrice)}` : "compra sob consulta",
    ctx.sell ? `venda ${formatUnitBRL(ctx.sell.unitPrice)}` : "venda sob consulta",
  ];
  return `${size} · ${parts.join(" · ")}`;
}

// ---------------------------------------------------------------------------
// Registro de operacao (emitido pelo /COMPRA e /VENDA na conclusao manual)
// ---------------------------------------------------------------------------

export interface OperationRecordParams {
  groupId: string;
  transactionId: string;
  date: Date;
  /** "buy" | "sell" para pares; "conversion" para cripto -> cripto. */
  side: "buy" | "sell" | "conversion";
  asset: string;
  counterAsset: string;
  quantity: number;
  /** Total na moeda/ativo de contrapartida. */
  counterTotal: number;
  unitPrice: number;
}

function operationTypeLabel(params: OperationRecordParams): string {
  if (params.side === "buy") return `COMPRA ${params.asset}`;
  if (params.side === "sell") return `VENDA ${params.asset}`;
  return `CONVERSÃO ${params.asset} → ${params.counterAsset}`;
}

/**
 * Registro completo da operacao no formato do painel da Mutual:
 * ID do grupo, ID da transacao, data, tipo, cotacao e montantes Total/Pendente.
 * "Pendente" = valor integral, pois a conclusao e manual nesta fase.
 */
export function formatOperationRecord(params: OperationRecordParams): string {
  const { groupId, transactionId, date, asset, counterAsset, quantity, counterTotal } = params;
  const isBRL = counterAsset === "BRL";

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

  const unitLabel = isBRL
    ? `1 ${asset} = ${formatUnitBRL(params.unitPrice)}`
    : `1 ${asset} = ${formatQty(params.unitPrice)} ${counterAsset}`;
  const counterLabel = isBRL ? formatBRL(counterTotal) : `${formatQty(counterTotal)} ${counterAsset}`;

  return [
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
    operationTypeLabel(params),
    "",
    "Cotação:",
    unitLabel,
    "",
    `💵 Montante em ${asset}:`,
    `Total: ${formatQty(quantity)} ${asset}`,
    `Pendente: ${formatQty(quantity)} ${asset}`,
    "",
    `💼 Montante em ${counterAsset}:`,
    `Total: ${counterLabel}`,
    `Pendente: ${counterLabel}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Textos padrao
// ---------------------------------------------------------------------------

export const MESSAGES = {
  /** Lado sem fee cadastrada ou com preco nao confiavel. */
  sideUnavailable: "sob consulta",

  groupNotLinked:
    "⚠️ Este grupo ainda não está vinculado a um cliente habilitado para cotações.",

  feeNotConfigured: "⚠️ Não há taxa configurada para esta operação neste cliente.",

  unsupportedOperation: (source: string, destination: string): string =>
    `⚠️ Operação não suportada: ${source} → ${destination}.`,

  quoteFailed: "⚠️ Não foi possível gerar a cotação agora. Tente novamente em instantes.",

  // Cotacoes tratadas manualmente (recurso de cotacao inativo no painel).
  quotesManual:
    "📩 Solicitação recebida! Esta cotação será conduzida manualmente por um operador da Mutual. Aguarde o retorno aqui no grupo.",

  // Encerramento padrao da operacao manual: NUNCA citar bot/estado.
  manualClosing:
    "A operação será concluída manualmente por um operador da Mutual. Aguarde a confirmação aqui no grupo. 🤝",

  // Compra ativada no painel, mas fase de ordens ainda desabilitada.
  ordersNotEnabledClosing:
    "ℹ️ A execução automática de ordens ainda não está habilitada.\nA operação será concluída manualmente por um operador da Mutual. Aguarde a confirmação aqui no grupo.",

  tradeWithRecord: (record: string, closing: string): string =>
    `✅ Pedido recebido!\n\n${record}\n\n${closing}`,

  // Sem cotacao valida (nenhuma, expirada ou ja consumida por outra confirmacao).
  tradeNeedQuote: [
    "ℹ️ Para confirmar a operação é preciso uma cotação atualizada — os preços mudam a cada segundo e cada cotação vale para uma única confirmação.",
    "Envie /COTAR (ex: /COTAR 50K USDT) e confirme com /COMPRA ou /VENDA.",
  ].join("\n"),

  // Lado pedido nao esta disponivel na cotacao ativa.
  tradeSideUnavailable: (side: "buy" | "sell"): string =>
    [
      `⚠️ A ${side === "buy" ? "compra" : "venda"} deste par ainda não está configurada para este cliente.`,
      "A operação será conduzida manualmente por um operador da Mutual.",
    ].join("\n"),

  // Argumentos do /COMPRA ou /VENDA nao batem com a cotacao ativa.
  tradeMismatch: (activeSummary: string | null, requested: string): string =>
    [
      activeSummary
        ? `⚠️ A cotação ativa é: ${activeSummary}`
        : "⚠️ Não há cotação ativa para esse pedido.",
      `Para operar ${requested}, gere uma cotação atualizada: envie /COTAR ${requested} e confirme em seguida.`,
    ].join("\n"),

  tradeArgsNotUnderstood: (activeSummary: string | null): string =>
    [
      "⚠️ Não entendi os detalhes do pedido.",
      activeSummary ? `A cotação ativa é: ${activeSummary}` : null,
      "Envie /COMPRA ou /VENDA (sem argumentos) para confirmar a cotação ativa, ou /COTAR <valor> <ativo> para uma nova cotação.",
    ]
      .filter(Boolean)
      .join("\n"),

  queueFinished: (total: number): string =>
    `✅ Fila de cotações concluída (${total} atualizações de preço). Envie /COTAR para uma nova cotação ou /COMPRA · /VENDA para fechar a operação.`,

  usageQuote: [
    "ℹ️ Formatos aceitos:",
    "/COTAR 50K USDT — cotação de compra e venda de 50.000 USDT",
    "/COTAR 5000 BRL USDT — usando R$ 5.000,00 como referência",
    "/COTAR 1 BTC BRL — cotação do par BTC/BRL",
    "/COTAR 1 BTC USDT — conversão entre criptoativos",
  ].join("\n"),

  unknownAsset:
    "⚠️ Ativo não reconhecido. Ativos disponíveis: BRL, BTC, ETH, USDT, USDC (USD/dólar = USDC).",

  help: [
    "🤖 Comandos disponíveis:",
    "/COTAR 50K USDT — cotação de compra e venda do par USDT/BRL",
    "/COTAR 5000 BRL USDT — cotação usando R$ 5.000,00 como referência",
    "/COTAR 1 BTC BRL — cotação do par BTC/BRL",
    "/COTAR 1 BTC USDT — conversão entre criptoativos",
    "/COMPRA 50K USDT — confirma a compra na cotação ativa",
    "/VENDA 50K USDT — confirma a venda na cotação ativa",
    "",
    "Cada cotação envia uma sequência de atualizações de preço em tempo real e vale para uma única confirmação.",
  ].join("\n"),
} as const;
