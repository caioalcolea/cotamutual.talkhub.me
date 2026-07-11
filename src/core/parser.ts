/**
 * Interpretacao dos comandos iniciados por "/" (secao 13 do descritivo).
 *
 * Exemplos aceitos:
 *   /REF 25K USDT            -> BRL -> USDT (quantidade do ativo)
 *   /COTAR 25K USDT          -> BRL -> USDT (quantidade do ativo)
 *   /COTAR 5000 BRL USDT     -> orcamento em BRL
 *   /COTAR 5000 BRL USD      -> BRL -> USDC (conversion)
 *   /COTAR 1 BTC BRL         -> venda (sell)
 *   /COTAR 25000 USDT BRL    -> venda (sell)
 *   /COTAR 1 BTC USDT        -> conversao cripto -> cripto
 *   /VENDER 1 BTC            -> atalho de venda para BRL
 *   /COMPRAR | /ORDER        -> intencao de compra (interrompe a fila)
 */

import { isKnownAsset, normalizeAsset } from "./assets.js";

export type ParsedCommand =
  | {
      kind: "quote";
      sourceAsset: string;
      destinationAsset: string;
      amount: number;
      /** "source": amount na unidade de origem. "destination": quantidade do ativo de destino. */
      amountKind: "source" | "destination";
      raw: string;
    }
  | {
      kind: "buy";
      raw: string;
      /** true quando o usuario passou argumentos (ex: /COMPRAR 1K BTC). */
      argsPresent: boolean;
      /** false quando os argumentos nao foram compreendidos. */
      argsValid: boolean;
      amount?: number;
      asset?: string;
    }
  | { kind: "help"; raw: string }
  | { kind: "invalid"; reason: string; raw: string };

const QUOTE_COMMANDS = new Set(["COTAR", "REF", "COTACAO", "COTAÇÃO"]);
const BUY_COMMANDS = new Set(["COMPRAR", "ORDER", "ORDEM", "BUY", "FECHAR"]);
const SELL_COMMANDS = new Set(["VENDER", "SELL", "VENDA"]);
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
    // Argumentos do /COMPRAR sao lidos e conferidos contra a cotacao ativa:
    //   /COMPRAR                -> confirma a cotacao ativa
    //   /COMPRAR BTC            -> confirma se a cotacao ativa for de BTC
    //   /COMPRAR 1K BTC         -> confirma se a cotacao ativa for de 1.000 BTC
    if (args.length === 0) {
      return { kind: "buy", raw, argsPresent: false, argsValid: true };
    }
    if (args.length === 1) {
      const asset = normalizeAsset(args[0]);
      if (isKnownAsset(asset) && asset !== "BRL") {
        return { kind: "buy", raw, argsPresent: true, argsValid: true, asset };
      }
      const amount = parseAmount(args[0]);
      if (amount !== null) {
        return { kind: "buy", raw, argsPresent: true, argsValid: true, amount };
      }
      return { kind: "buy", raw, argsPresent: true, argsValid: false };
    }
    const amount = parseAmount(args[0]);
    const asset = normalizeAsset(args[1]);
    if (amount !== null && isKnownAsset(asset) && asset !== "BRL") {
      return { kind: "buy", raw, argsPresent: true, argsValid: true, amount, asset };
    }
    return { kind: "buy", raw, argsPresent: true, argsValid: false };
  }

  if (SELL_COMMANDS.has(command)) {
    // /VENDER <qtd> <ativo> -> ativo -> BRL
    if (args.length < 2) {
      return { kind: "invalid", reason: "usage-sell", raw };
    }
    const amount = parseAmount(args[0]);
    const source = normalizeAsset(args[1]);
    if (amount === null || !isKnownAsset(source) || source === "BRL") {
      return { kind: "invalid", reason: "usage-sell", raw };
    }
    return {
      kind: "quote",
      sourceAsset: source,
      destinationAsset: "BRL",
      amount,
      amountKind: "source",
      raw,
    };
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

  if (args.length === 2) {
    // /COTAR 25K USDT -> BRL -> ativo, quantidade do ATIVO de destino.
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
    raw,
  };
}
