/**
 * Testes do fallback de merchants: quando a LISTAGEM recusa o service token
 * ("Service token not accepted on this endpoint"), o sistema consulta as
 * organizacoes uma a uma e, em ultimo caso, usa o snapshot em disco.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MerchantCache } from "../src/cache/caches.js";
import { MerchantStore } from "../src/state/merchant-store.js";
import { mergeMerchantIds, DEFAULT_KNOWN_MERCHANT_IDS } from "../src/mutual/known-merchants.js";
import type { MutualClients } from "../src/mutual/client.js";

const UNAUTHORIZED = Object.assign(new Error("401"), {
  isAxiosError: true,
  config: { url: "/api/v2/resource/merchants", method: "get" },
  response: {
    status: 401,
    data: { detail: "Service token not accepted on this endpoint" },
  },
});

/** Cliente falso: listagem 401, individual funcionando para IDs conhecidos. */
function fakeClients(known: Record<string, unknown>, listingWorks = false) {
  const calls = { listing: 0, byId: 0 };
  const prod = {
    get: async (url: string) => {
      if (url === "/api/v2/resource/merchants") {
        calls.listing += 1;
        if (listingWorks) {
          return { data: { error: false, data: Object.entries(known).map(([id, m]) => ({ id, ...(m as object) })) } };
        }
        throw UNAUTHORIZED;
      }
      const match = /^\/api\/v2\/resource\/merchants\/(.+)$/.exec(url);
      if (match) {
        calls.byId += 1;
        const id = decodeURIComponent(match[1]);
        const merchant = known[id];
        if (!merchant) {
          throw Object.assign(new Error("404"), {
            isAxiosError: true,
            config: { url, method: "get" },
            response: { status: 404, data: {} },
          });
        }
        return { data: { error: false, data: { id, ...(merchant as object) } } };
      }
      throw new Error(`url inesperada: ${url}`);
    },
  };
  return { clients: { prod, hml: prod, crypto: prod } as unknown as MutualClients, calls };
}

const GROUP = { id: "lg", channel: "whatsapp", groupId: "1203@g.us", name: "teste", active: true };

test("listagem 401 -> consulta individual por organização mantém o sistema de pé", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-fb-"));
  const { clients, calls } = fakeClients({
    org_A: { legalName: "Cliente A", status: "active", linkGroups: [GROUP] },
    org_B: { legalName: "Cliente B", status: "active", linkGroups: [] },
  });
  const cache = new MerchantCache(clients, 60_000, {
    store: new MerchantStore(dir),
    extraIds: ["org_A", "org_B"],
    fallbackConcurrency: 1,
  });

  const merchants = await cache.getAll();
  assert.equal(merchants.length, 2);
  assert.equal(cache.snapshot().source, "individual");
  assert.equal(calls.listing, 1, "tenta a listagem antes do fallback");
  assert.ok(calls.byId >= 2, "consulta cada organização");
  // O vínculo de grupo é preservado no fallback.
  assert.equal(merchants.find((m) => m.id === "org_A")?.linkGroups?.[0].groupId, "1203@g.us");
});

test("tudo fora do ar -> snapshot em disco preserva grupos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-snap-"));
  const store = new MerchantStore(dir);
  store.save([{ id: "org_A", legalName: "Cliente A", status: "active", linkGroups: [GROUP] }]);

  const offline = {
    get: async () => {
      throw Object.assign(new Error("ECONNREFUSED"), {
        isAxiosError: true,
        config: { url: "/api/v2/resource/merchants", method: "get" },
        code: "ECONNREFUSED",
      });
    },
  };
  const cache = new MerchantCache(
    { prod: offline, hml: offline, crypto: offline } as unknown as MutualClients,
    60_000,
    { store, extraIds: ["org_A"] },
  );

  const merchants = await cache.getAll();
  assert.equal(cache.snapshot().source, "snapshot");
  assert.equal(merchants.length, 1);
  assert.equal(merchants[0].linkGroups?.[0].groupId, "1203@g.us");
});

test("listagem funcionando volta a ser a fonte e alimenta o snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-list-"));
  const store = new MerchantStore(dir);
  const { clients } = fakeClients(
    { org_A: { legalName: "Cliente A", status: "active", linkGroups: [GROUP] } },
    true,
  );
  const cache = new MerchantCache(clients, 60_000, { store });

  const merchants = await cache.getAll();
  assert.equal(cache.snapshot().source, "listing");
  assert.equal(merchants.length, 1);
  // IDs vistos ficam registrados para um eventual fallback futuro.
  assert.ok(store.knownIds().includes("org_A"));
});

test("catálogo de IDs: semente + .env + snapshot, sem duplicar", () => {
  const merged = mergeMerchantIds(["org_X", "org_A"], ["org_A"], DEFAULT_KNOWN_MERCHANT_IDS);
  assert.equal(merged[0], "org_X");
  assert.equal(new Set(merged).size, merged.length, "sem duplicatas");
  assert.ok(merged.includes("org_3DXaWmcAaguU8rn2ryheTS2kRdw"), "mantém a semente conhecida");
});
