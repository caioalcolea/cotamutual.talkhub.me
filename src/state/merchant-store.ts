/**
 * Snapshot em disco dos merchants.
 *
 * Serve a dois propositos:
 *   1. lembrar os IDs de organizacao ja vistos, para a consulta individual
 *      (fallback quando a listagem recusa o service token);
 *   2. ultimo estado valido — se a listagem E a consulta individual falharem,
 *      os grupos continuam resolvendo pelo snapshot (com aviso de data).
 *
 * Gravacao atomica em DATA_DIR/merchants-snapshot.json.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MutualMerchant } from "../types.js";
import { logger } from "../logger.js";

interface SnapshotFile {
  savedAt: string;
  merchants: MutualMerchant[];
  knownIds: string[];
}

export class MerchantStore {
  private readonly filePath: string;
  private data: SnapshotFile = { savedAt: "", merchants: [], knownIds: [] };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "merchants-snapshot.json");
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<SnapshotFile>;
      this.data = {
        savedAt: parsed.savedAt ?? "",
        merchants: parsed.merchants ?? [],
        knownIds: parsed.knownIds ?? [],
      };
      logger.info("Snapshot de merchants carregado", {
        count: this.data.merchants.length,
        savedAt: this.data.savedAt || null,
      });
    } catch {
      this.data = { savedAt: "", merchants: [], knownIds: [] };
    }
  }

  private persist(): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, this.filePath);
    } catch (error) {
      logger.error("Falha ao gravar snapshot de merchants", { error: String(error) });
    }
  }

  merchants(): MutualMerchant[] {
    return this.data.merchants;
  }

  savedAt(): string | null {
    return this.data.savedAt || null;
  }

  knownIds(): string[] {
    return this.data.knownIds;
  }

  /** Registra o resultado de uma consulta bem-sucedida (lista ou parcial). */
  save(merchants: MutualMerchant[]): void {
    if (merchants.length === 0) return;
    const ids = new Set(this.data.knownIds);
    for (const merchant of merchants) {
      if (merchant.id) ids.add(merchant.id);
    }
    this.data = {
      savedAt: new Date().toISOString(),
      merchants,
      knownIds: [...ids],
    };
    this.persist();
  }

  /** Guarda IDs descobertos sem sobrescrever o snapshot de merchants. */
  rememberIds(ids: readonly string[]): void {
    const set = new Set(this.data.knownIds);
    let changed = false;
    for (const raw of ids) {
      const id = String(raw || "").trim();
      if (id && !set.has(id)) {
        set.add(id);
        changed = true;
      }
    }
    if (changed) {
      this.data.knownIds = [...set];
      this.persist();
    }
  }
}
