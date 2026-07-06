#!/usr/bin/env node
/**
 * Ponto de entrada do servidor MCP de cotacao/compra cripto (Mutual API v2).
 *
 * Transporte padrao: Streamable HTTP (stateless) em /mcp.
 * Tambem expoe:
 *   GET /health  -> healthcheck (aberto)
 *   GET /        -> info publica (sem segredos)
 *
 * Defina TRANSPORT=stdio para rodar localmente via stdio (ex: MCP Inspector / CLI).
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { createMutualClients } from "./mutual/client.js";
import { createServer } from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const clients = createMutualClients(config);

  // ---- Transporte stdio (uso local) ----
  if (config.transport === "stdio") {
    const server = createServer(clients);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("MCP server rodando via stdio");
    return;
  }

  // ---- Transporte HTTP (producao, atras do Traefik) ----
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // CORS basico (permite MCP Inspector e clientes browser; ajuste se quiser restringir)
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id, mcp-session-id, mcp-protocol-version",
    );
    res.header("Access-Control-Expose-Headers", "Mcp-Session-Id, mcp-session-id");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Healthcheck (aberto) — usado pelo Docker
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", service: SERVER_NAME, version: SERVER_VERSION });
  });

  // Info publica (sem dados sensiveis)
  app.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
      service: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      endpoint: "/mcp",
      cryptoEnv: config.cryptoEnv,
      authRequired: Boolean(config.mcpAuthToken),
    });
  });

  // Guarda de autenticacao Bearer para /mcp (se MCP_AUTH_TOKEN definido)
  const authGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (!config.mcpAuthToken) {
      next();
      return;
    }
    const header = req.headers["authorization"];
    if (header !== `Bearer ${config.mcpAuthToken}`) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Nao autorizado: token MCP ausente ou invalido." },
        id: null,
      });
      return;
    }
    next();
  };

  // Endpoint MCP (Streamable HTTP, stateless): nova instancia de server+transport por requisicao
  app.post("/mcp", authGuard, async (req: Request, res: Response) => {
    const server = createServer(clients);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("Falha ao processar requisicao MCP", { error: String(error) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Erro interno do servidor MCP." },
          id: null,
        });
      }
    }
  });

  // GET/DELETE em /mcp nao sao suportados no modo stateless
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Metodo nao suportado. Use POST em /mcp." },
      id: null,
    });
  };
  app.get("/mcp", authGuard, methodNotAllowed);
  app.delete("/mcp", authGuard, methodNotAllowed);

  app.listen(config.port, () => {
    logger.info("MCP server (HTTP) iniciado", {
      port: config.port,
      endpoint: "/mcp",
      cryptoEnv: config.cryptoEnv,
      authRequired: Boolean(config.mcpAuthToken),
    });
    if (!config.mcpAuthToken) {
      logger.warn(
        "MCP_AUTH_TOKEN nao definido: o endpoint /mcp esta SEM autenticacao. Defina um token em producao.",
      );
    }
  });
}

main().catch((error) => {
  logger.error("Erro fatal ao iniciar o servidor", { error: String(error) });
  process.exit(1);
});
