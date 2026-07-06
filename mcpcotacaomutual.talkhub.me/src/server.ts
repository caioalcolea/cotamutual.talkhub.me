/**
 * Fabrica do servidor MCP. Cria uma instancia e registra as ferramentas.
 *
 * No transporte HTTP stateless criamos uma instancia POR requisicao (ver index.ts),
 * por isso esta funcao e barata e isolada.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { MutualClients } from "./mutual/client.js";
import { registerTools } from "./tools.js";

export function createServer(clients: MutualClients): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, clients);
  return server;
}
