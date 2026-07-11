/**
 * Descricao detalhada de erros para log/painel.
 *
 * Para erros HTTP (axios), inclui metodo, URL, status e corpo da resposta —
 * essencial para diagnosticar recusas da Mutual/Evolution (par nao suportado,
 * rede invalida, credencial, etc.) que String(error) esconderia.
 */

import axios from "axios";

export function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const method = (error.config?.method ?? "?").toUpperCase();
    const url = error.config?.url ?? "?";
    const status = error.response?.status;
    if (typeof status === "number") {
      const body = JSON.stringify(error.response?.data ?? "").slice(0, 500);
      return `${method} ${url} -> HTTP ${status} ${body}`;
    }
    if (error.code === "ECONNABORTED") {
      return `${method} ${url} -> timeout`;
    }
    return `${method} ${url} -> ${error.code ?? error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
