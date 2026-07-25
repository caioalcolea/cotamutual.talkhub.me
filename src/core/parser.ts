/**
 * Interpretacao dos comandos iniciados por "/".
 *
 * Cotacao (mostra os DOIS lados do par — compra e venda):
 *   /COTAR 50K USDT          -> par USDT/BRL, tamanho 50.000 USDT
 *   /REF 25K USDT            -> idem
 *   /COTAR 5000 BRL USDT     -> par USDT/BRL, tamanho R$ 5.000 (orcamento)
 *   /COTAR 1 BTC BRL         -> par BTC/BRL, tamanho 1 BTC
 *   /COTAR 1 BTC USDT        -> conversao cripto -> cripto
 *
 * Confirmacao (consome a cotacao ativa do grupo):
 *   /COMPRA [50K USDT]       -> confirma o lado COMPRA
 *   /VENDA  [50K USDT]       -> confirma o lado VENDA
 */

import { isKnownAsset, normalizeAsset } from "./assets.js";

export type TradeSide = "buy" | "sell";

/** Como o tamanho da operacao foi informado. */
export type SizeKind = "asset" | "brl";

export type ParsedCommand =
  | {
      kind: "quote";
      sourceAsset: string;
      destinationAsset: string;
      amount: number;
      /** "source": amount na unidade de origem. "destination": quantidade do ativo de destino. */
      amountKind: "source" | "destination";
      /** Token do valor exatamente como digitado (ex: "50k") — usado nas dicas. */
      amountRaw: string;
      raw: string;
    }
  | {
      kind: "trade";
      side: TradeSide;
      raw: string;
      /** true quando o usuario passou argumentos (ex: /COMPRA 50K USDT). */
      argsPresent: boolean;
      /** false quando os argumentos nao foram compreendidos. */
      argsValid: boolean;
      amount?: number;
      amountRaw?: string;
      sizeKind?: SizeKind;
      asset?: string;
    }
  | { kind: "help"; raw: string }
  | { kind: "invalid"; reason: string; raw: string };

const QUOTE_COMMANDS = new Set(["COTAR", "REF", "COTACAO", "COTAÇÃO", "COTACOES", "COTAÇÕES"]);
const BUY_COMMANDS = new Set(["COMPRA", "COMPRAR", "BUY", "ORDER", "ORDEM", "FECHAR"]);
const SELL_COMMANDS = new Set(["VENDA", "VENDER", "SELL"]);
const HELP_COMMANDS = new Set(["AJUDA", "HELP", "MENU", "COMANDOS"]);

/**
 * Converte "25K", "1,5M", "5.000,50", "0.5" em numero.
 * Heuristica pt-BR: "." seguido de exatamente 3 digitos no fim = separador de milhar.
 */
export function parseAmount(raw: string): number | null {
  const match = /^([\d.,]+)\s*([kKmM])?$/.exec(raw.trim());
  if (!match) return null;

  let digits = match[1];
  const suffix = (match[2] || "").toUpperCase();

  const hasDot = digits.includes(".");
  const hasComma = digits.includes(",");

  if (hasDot && hasComma) {
    // "5.000,50" -> "." milhar, "," decimal
    digits = digits.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    // "1,5" -> decimal
    digits = digits.replace(",", ".");
  } else if (hasDot) {
    // "5.000" -> milhar; "0.5" -> decimal
    if (/^\d{1,3}(\.\d{3})+$/.test(digits)) {
      digits = digits.replace(/\./g, "");
    }
  }

  let value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return null;

  if (suffix === "K") value *= 1_000;
  if (suffix === "M") value *= 1_000_000;

  return value;
}

/** Interpreta os argumentos de /COMPRA e /VENDA. */
function parseTradeArgs(side: TradeSide, args: string[], raw: string): ParsedCommand {
  if (args.length === 0) {
    return { kind: "trade", side, raw, argsPresent: false, argsValid: true };
  }

  // /COMPRA USDT
  if (args.length === 1) {
    const asset = normalizeAsset(args[0]);
    if (isKnownAsset(asset) && asset !== "BRL") {
      return { kind: "trade", side, raw, argsPresent: true, argsValid: true, asset };
    }
    const amount = parseAmount(args[0]);
    if (amount !== null) {
      return {
        kind: "trade",
        side,
        raw,
        argsPresent: true,
        argsValid: true,
        amount,
        amountRaw: args[0],
        sizeKind: "asset",
      };
    }
    return { kind: "trade", side, raw, argsPresent: true, argsValid: false };
  }

  const amount = parseAmount(args[0]);

  // /COMPRA 5000 BRL USDT  (tamanho em BRL)
  if (args.length >= 3) {
    const first = normalizeAsset(args[1]);
    const second = normalizeAsset(args[2]);
    if (amount !== null && first === "BRL" && isKnownAsset(second) && second !== "BRL") {
      return {
        kind: "trade",
        side,
        raw,
        argsPresent: true,
        argsValid: true,
        amount,
        amountRaw: args[0],
        sizeKind: "brl",
        asset: second,
      };
    }
    // /COMPRA 1 BTC BRL -> tamanho em ativo
    if (amount !== null && isKnownAsset(first) && first !== "BRL" && second === "BRL") {
      return {
        kind: "trade",
        side,
        raw,
        argsPresent: true,
        argsValid: true,
        amount,
        amountRaw: args[0],
        sizeKind: "asset",
        asset: first,
      };
    }
    return { kind: "trade", side, raw, argsPresent: true, argsValid: false };
  }

  // /COMPRA 50K USDT
  const asset = normalizeAsset(args[1]);
  if (amount !== null && isKnownAsset(asset) && asset !== "BRL") {
    return {
      kind: "trade",
      side,
      raw,
      argsPresent: true,
      argsValid: true,
      amount,
      amountRaw: args[0],
      sizeKind: "asset",
      asset,
    };
  }
  return { kind: "trade", side, raw, argsPresent: true, argsValid: false };
}

/** Retorna null quando a mensagem NAO e um comando (deve ser ignorada). */
export function parseCommand(text: string | null | undefined): ParsedCommand | null {
  const raw = String(text || "").trim();
  if (!raw.startsWith("/")) return null;

  const parts = raw.slice(1).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const command = parts[0].toUpperCase();
  const args = parts.slice(1);

  if (HELP_COMMANDS.has(command)) {
    return { kind: "help", raw };
  }

  if (BUY_COMMANDS.has(command)) {
    return parseTradeArgs("buy", args, raw);
  }

  if (SELL_COMMANDS.has(command)) {
    return parseTradeArgs("sell", args, raw);
  }

  if (!QUOTE_COMMANDS.has(command)) {
    // Comando desconhecido: ignorar silenciosamente (nao poluir o grupo).
    return null;
  }

  if (args.length < 2) {
    return { kind: "invalid", reason: "usage-quote", raw };
  }

  const amount = parseAmount(args[0]);
  if (amount === null) {
    return { kind: "invalid", reason: "usage-quote", raw };
  }
  const amountRaw = args[0];

  if (args.length === 2) {
    // /COTAR 25K USDT -> par ATIVO/BRL, tamanho na quantidade do ativo.
    const destination = normalizeAsset(args[1]);
    if (!isKnownAsset(destination)) {
      return { kind: "invalid", reason: "unknown-asset", raw };
    }
    if (destination === "BRL") {
      return { kind: "invalid", reason: "usage-quote", raw };
    }
    return {
      kind: "quote",
      sourceAsset: "BRL",
      destinationAsset: destination,
      amount,
      amountKind: "destination",
      amountRaw,
      raw,
    };
  }

  // /COTAR <valor> <origem> <destino>
  const source = normalizeAsset(args[1]);
  const destination = normalizeAsset(args[2]);
  if (!isKnownAsset(source) || !isKnownAsset(destination)) {
    return { kind: "invalid", reason: "unknown-asset", raw };
  }
  if (source === destination) {
    return { kind: "invalid", reason: "same-asset", raw };
  }

  return {
    kind: "quote",
    sourceAsset: source,
    destinationAsset: destination,
    amount,
    amountKind: "source",
    amountRaw,
    raw,
  };
}
