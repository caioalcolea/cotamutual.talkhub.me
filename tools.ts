/**
 * Registro das ferramentas (tools) MCP que expoem a Mutual API v2.
 *
 * Ferramentas:
 *   - mutual_list_merchants       (read-only)
 *   - mutual_get_merchant_fees    (read-only)
 *   - mutual_get_crypto_quote     (read-only, gera nova cotacao a cada chamada)
 *   - mutual_create_crypto_order  (DESTRUTIVA: cria ordem real / movimenta valor)
 */

import { randomBytes } from "node:crypto";
import axios from "axios";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MutualClients } from "./mutual/client.js";
import { fetchMerchantFees, fetchMerchants } from "./mutual/merchants.js";
import { fetchCryptoQuote } from "./mutual/quote.js";
import { createCryptoOrder } from "./mutual/orders.js";
import { logger } from "./logger.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function extractDetail(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const candidate = d["detail"] ?? d["message"] ?? d["title"];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return fallback;
}

function formatError(error: unknown, action: string): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail = extractDetail(error.response?.data, error.message);
    if (status === 404) {
      return `Erro ao ${action}: recurso nao encontrado (404). ${detail}`;
    }
    if (status === 401 || status === 403) {
      return `Erro ao ${action}: nao autorizado (${status}). Verifique MUTUAL_API_KEY e x-service-token. ${detail}`;
    }
    if (status === 429) {
      return `Erro ao ${action}: limite de requisicoes excedido (429). Aguarde e tente novamente.`;
    }
    if (typeof status === "number") {
      return `Erro ao ${action}: a Mutual API retornou HTTP ${status}. ${detail}`;
    }
    if (error.code === "ECONNABORTED") {
      return `Erro ao ${action}: tempo limite excedido ao contatar a Mutual API. Tente novamente.`;
    }
    return `Erro ao ${action}: falha de rede ao contatar a Mutual API. ${error.message}`;
  }
  return `Erro ao ${action}: ${error instanceof Error ? error.message : String(error)}`;
}

function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

function generateExternalId(): string {
  return `ext-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

// ----------------------------------------------------------------------------
// Zod input schemas
// ----------------------------------------------------------------------------

const ListMerchantsInput = z
  .object({
    page: z.number().int().min(1).default(1).describe("Numero da pagina (>= 1). Padrao: 1."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe("Itens por pagina (1-100). Padrao: 10."),
  })
  .strict();

const MerchantFeesInput = z
  .object({
    merchantId: z
      .string()
      .min(1)
      .describe(
        "ID do merchant (campo data[].id de mutual_list_merchants, ex: 'org_3DXaWmcAaguU8rn2ryheTS2kRdw'). NAO use organizationId.",
      ),
  })
  .strict();

const QuoteInput = z
  .object({
    amount: z
      .number()
      .positive("amount deve ser maior que zero")
      .describe("Valor a comprar, na unidade de sourceAsset (ex: 100)."),
    targetAsset: z.string().min(1).describe("Ativo de destino desejado (ex: 'BTC', 'USDT')."),
    symbol: z.string().min(1).describe("Par de negociacao (ex: 'BTC-BRL')."),
    sourceAsset: z
      .string()
      .min(1)
      .default("BRL")
      .describe("Ativo de origem (ex: 'BRL', 'MBC', 'USDT'). Padrao: 'BRL'."),
    targetNetwork: z
      .string()
      .min(1)
      .default("BITCOIN")
      .describe("Rede do ativo de destino (ex: 'BITCOIN', 'TRON', 'ERC20'). Padrao: 'BITCOIN'."),
  })
  .strict();

const CreateOrderInput = z
  .object({
    walletId: z
      .string()
      .min(1)
      .describe("ID da wallet de origem (ex: 'wal_LUmChNCfM3pfFDwZp2CZkkKsx4s7'). Deve existir na Mutual."),
    amount: z
      .number()
      .positive("amount deve ser maior que zero")
      .describe("Quantidade a debitar do sourceAsset (ex: 100)."),
    destinationAsset: z.string().min(1).describe("Ativo cripto a receber (ex: 'BTC')."),
    symbol: z.string().min(1).describe("Par de negociacao (ex: 'BTC-BRL')."),
    sourceAsset: z
      .string()
      .min(1)
      .default("MBC")
      .describe("Ativo de origem debitado. Padrao: 'MBC' (conforme fluxo validado)."),
    externalId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Identificador idempotente unico da ordem. Se omitido, e gerado automaticamente como 'ext-<timestamp>-<rand>'. NUNCA reutilize um externalId ja usado.",
      ),
    cost: z
      .number()
      .positive()
      .optional()
      .describe("Custo total da ordem. Se omitido, usa o valor de amount."),
    qty: z
      .string()
      .optional()
      .default("0.001")
      .describe("Quantidade estimada do ativo de destino para ordem market (string). Padrao: '0.001'."),
  })
  .strict();

// ----------------------------------------------------------------------------
// Registro
// ----------------------------------------------------------------------------

export function registerTools(server: McpServer, clients: MutualClients): void {
  // --- mutual_list_merchants -------------------------------------------------
  server.registerTool(
    "mutual_list_merchants",
    {
      title: "Listar merchants Mutual",
      description: `Lista os merchants (clientes/lojistas) cadastrados na Mutual, em PRODUCAO.

Use para descobrir o merchantId que sera necessario em mutual_get_merchant_fees e
para identificar a qual merchant um cliente esta associado. Operacao somente leitura.

Args:
  - page (number): pagina, >= 1 (padrao 1)
  - limit (number): itens por pagina, 1-100 (padrao 10)

Retorna JSON:
  {
    "message": string,
    "count": number,            // itens nesta pagina
    "pagination": { page, limit, totalItems, totalPages, hasNextPage, hasPreviousPage },
    "merchants": [
      { "id": string, "organizationId": string, "legalName": string,
        "legalDocument": string, "status": string, "email": string,
        "createdAt": string, "updatedAt": string }
    ]
  }

Observacao: para consultar fees use SEMPRE merchants[].id (ex: 'org_3DXa...'),
nunca organizationId.`,
      inputSchema: ListMerchantsInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const data = await fetchMerchants(clients, params.page, params.limit);
        const merchants = (data.data ?? []).map((m) => ({
          id: m.id,
          organizationId: m.organizationId ?? null,
          legalName: m.legalName ?? null,
          legalDocument: m.legalDocument ?? null,
          status: m.status ?? null,
          email: m.email ?? null,
          createdAt: m.createdAt ?? null,
          updatedAt: m.updatedAt ?? null,
        }));
        return ok({
          message: data.message,
          count: merchants.length,
          pagination: data.pagination ?? null,
          merchants,
        });
      } catch (error) {
        logger.error("mutual_list_merchants falhou", { error: String(error) });
        return fail(formatError(error, "listar merchants"));
      }
    },
  );

  // --- mutual_get_merchant_fees ---------------------------------------------
  server.registerTool(
    "mutual_get_merchant_fees",
    {
      title: "Consultar fees do merchant",
      description: `Retorna as taxas (fees) configuradas para um merchant especifico, em PRODUCAO.

As fees sao especificas por combinacao de operacao + ativo de origem + ativo de destino
(ex: 'conversion' + 'BTC' + 'USDT'). Use o ID retornado em mutual_list_merchants
(campo merchants[].id). Operacao somente leitura.

Args:
  - merchantId (string): ID do merchant (ex: 'org_3DXaWmcAaguU8rn2ryheTS2kRdw')

Retorna JSON:
  {
    "message": string,
    "count": number,
    "fees": [
      { "id": string, "scopeType": string, "scopeId": string, "operation": string,
        "sourceAsset": string, "destinationAsset": string,
        "feeFixed": number, "feePercentage": number,
        "createdAt": string, "updatedAt": string }
    ]
  }

Erros:
  - 404: merchant nao encontrado (verifique o merchantId).`,
      inputSchema: MerchantFeesInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const data = await fetchMerchantFees(clients, params.merchantId);
        const fees = (data.data ?? []).map((f) => ({
          id: f.id,
          scopeType: f.scopeType ?? null,
          scopeId: f.scopeId ?? null,
          operation: f.operation ?? null,
          sourceAsset: f.sourceAsset ?? null,
          destinationAsset: f.destinationAsset ?? null,
          feeFixed: f.feeFixed ?? null,
          feePercentage: f.feePercentage ?? null,
          createdAt: f.createdAt ?? null,
          updatedAt: f.updatedAt ?? null,
        }));
        return ok({ message: data.message, count: fees.length, fees });
      } catch (error) {
        logger.error("mutual_get_merchant_fees falhou", { error: String(error) });
        return fail(formatError(error, "consultar fees do merchant"));
      }
    },
  );

  // --- mutual_get_crypto_quote ----------------------------------------------
  server.registerTool(
    "mutual_get_crypto_quote",
    {
      title: "Cotar criptoativo",
      description: `Gera uma cotacao de compra de criptoativo na Mutual.

IMPORTANTE: a cotacao tem validade curta (no exemplo validado ~30 segundos).
Cada chamada gera um novo quote_id, price e expires_at. Sempre apresente o resumo
ao usuario e obtenha confirmacao ANTES de expires_at. Se expirar, gere outra cotacao.
Esta ferramenta NAO executa compra; apenas consulta. Para comprar use
mutual_create_crypto_order.

Args:
  - amount (number): valor a comprar na unidade de sourceAsset (ex: 100)
  - targetAsset (string): ativo desejado (ex: 'BTC')
  - symbol (string): par (ex: 'BTC-BRL')
  - sourceAsset (string): ativo de origem (padrao 'BRL')
  - targetNetwork (string): rede de destino (padrao 'BITCOIN')

Retorna JSON:
  {
    "message": string,
    "quote": {
      "quote_id": string, "type": string,
      "source_asset": string, "target_asset": string,
      "source_amount": string, "target_amount": string,
      "price": string, "fee_bps": number, "provider": string,
      "locked_at": string, "expires_at": string
    },
    "now": string,                 // horario do servidor (ISO)
    "valid": boolean,              // se now < expires_at
    "expires_in_seconds": number   // segundos restantes (0 se expirada)
  }`,
      inputSchema: QuoteInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const data = await fetchCryptoQuote(clients, {
          symbol: params.symbol,
          amount: params.amount,
          sourceAsset: params.sourceAsset,
          targetAsset: params.targetAsset,
          targetNetwork: params.targetNetwork,
        });
        const now = new Date();
        const expiresAt = data.data?.expires_at ? new Date(data.data.expires_at) : null;
        const valid = expiresAt ? now.getTime() < expiresAt.getTime() : false;
        const expiresInSeconds = expiresAt
          ? Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / 1000))
          : 0;
        return ok({
          message: data.message,
          quote: data.data,
          now: now.toISOString(),
          valid,
          expires_in_seconds: expiresInSeconds,
        });
      } catch (error) {
        logger.error("mutual_get_crypto_quote falhou", { error: String(error) });
        return fail(formatError(error, "consultar cotacao cripto"));
      }
    },
  );

  // --- mutual_create_crypto_order -------------------------------------------
  server.registerTool(
    "mutual_create_crypto_order",
    {
      title: "Criar ordem de compra cripto (DESTRUTIVA)",
      description: `Cria uma ordem REAL de compra de criptoativo na Mutual. ACAO IRREVERSIVEL:
movimenta valor do cliente. So chame apos confirmacao explicita do usuario e com uma
cotacao ainda valida (verifique 'valid' em mutual_get_crypto_quote).

O externalId garante idempotencia: cada ordem precisa de um valor unico. Se omitido,
e gerado automaticamente. NUNCA reutilize um externalId ja enviado.

Args:
  - walletId (string): wallet de origem (ex: 'wal_LUmChNCfM3pfFDwZp2CZkkKsx4s7')
  - amount (number): quantidade a debitar do sourceAsset (ex: 100)
  - destinationAsset (string): ativo a receber (ex: 'BTC')
  - symbol (string): par (ex: 'BTC-BRL')
  - sourceAsset (string): ativo debitado (padrao 'MBC')
  - externalId (string, opcional): idempotente; auto-gerado se ausente
  - cost (number, opcional): custo total; usa amount se ausente
  - qty (string, opcional): quantidade estimada do destino (padrao '0.001')

Retorna JSON:
  {
    "message": string,
    "externalIdUsed": string,
    "order": { ...resposta crua da Mutual, incluindo "id" (codigo da ordem) e "status" }
  }

Erros:
  - 404 "Wallet not found": a walletId informada nao existe.

Observacao: a resposta inicial pode trazer destination.amount = "0" e provider = "Unset";
isso indica que a ordem foi criada mas pode precisar de processamento assincrono para
atualizar execucao/quantidade final.`,
      inputSchema: CreateOrderInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const externalId = params.externalId ?? generateExternalId();
      try {
        const data = await createCryptoOrder(clients, {
          walletId: params.walletId,
          externalId,
          amount: params.amount,
          sourceAsset: params.sourceAsset,
          destinationAsset: params.destinationAsset,
          symbol: params.symbol,
          cost: params.cost ?? params.amount,
          qty: params.qty,
        });
        logger.info("Ordem cripto criada", {
          externalId,
          walletId: params.walletId,
          symbol: params.symbol,
        });
        return ok({
          message: data.message,
          externalIdUsed: externalId,
          order: data.data,
        });
      } catch (error) {
        logger.error("mutual_create_crypto_order falhou", {
          externalId,
          error: String(error),
        });
        return fail(formatError(error, "criar ordem de compra cripto"));
      }
    },
  );
}
