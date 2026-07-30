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
import { probeMerchantViaFees } from "../src/mutual/merchants.js";
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

// ---------------------------------------------------------------------------
// Producao real: a rota de merchant por ID NAO existe (Express devolve 404 em
// HTML, "Cannot GET /api/v2/resource/merchants/{id}"). O unico endpoint por
// organizacao que responde e o de FEES — ele vira a sonda de existencia.
// ---------------------------------------------------------------------------

const NOT_FOUND_HTML = (url: string) =>
  Object.assign(new Error("404"), {
    isAxiosError: true,
    config: { url, method: "get" },
    response: {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
      data: `<!DOCTYPE html><html><body><pre>Cannot GET ${url}</pre></body></html>`,
    },
  });

/** Reproduz a producao: listagem 401, merchant/{id} 404 HTML, fees 200. */
function productionClients(liveIds: readonly string[]) {
  const calls = { listing: 0, byId: 0, fees: new Map<string, number>() };
  const prod = {
    get: async (url: string) => {
      if (url === "/api/v2/resource/merchants") {
        calls.listing += 1;
        throw UNAUTHORIZED;
      }
      const fees = /^\/api\/v2\/resource\/fees\/merchant\/(.+)$/.exec(url);
      if (fees) {
        const id = decodeURIComponent(fees[1]);
        calls.fees.set(id, (calls.fees.get(id) ?? 0) + 1);
        if (!liveIds.includes(id)) throw NOT_FOUND_HTML(url);
        return { data: { error: false, data: [{ id: "fee1", operation: "buy" }] } };
      }
      if (/^\/api\/v2\/resource\/merchants?\/(.+)$/.test(url)) {
        calls.byId += 1;
        throw NOT_FOUND_HTML(url);
      }
      throw new Error(`url inesperada: ${url}`);
    },
  };
  return { clients: { prod, hml: prod, crypto: prod } as unknown as MutualClients, calls };
}

test("sonda via fees: 200 confirma o merchant e traz o nome do catálogo", async () => {
  const { clients } = productionClients(["org_3G8ynOqchbFQnpR34OWQ0zwDA8k"]);
  const merchant = await probeMerchantViaFees(clients, "org_3G8ynOqchbFQnpR34OWQ0zwDA8k");
  assert.ok(merchant, "merchant que responde fees existe");
  assert.equal(merchant?.legalName, "VIZZO SOLUCOES EM PAGAMENTOS LTDA");
  assert.equal(merchant?.status, "active");
});

test("sonda via fees: 404 significa merchant inacessível (sem erro)", async () => {
  const { clients } = productionClients([]);
  assert.equal(await probeMerchantViaFees(clients, "org_inexistente"), null);
});

test("produção: merchant/{id} 404 HTML não derruba o fallback — a sonda de fees resolve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-probe-"));
  const { clients, calls } = productionClients(["org_A"]);
  const cache = new MerchantCache(clients, 60_000, {
    store: new MerchantStore(dir),
    extraIds: ["org_A", "org_MORTO"],
    fallbackConcurrency: 1,
  });

  const merchants = await cache.getAll();
  assert.equal(cache.snapshot().source, "individual");
  assert.ok(
    merchants.some((m) => m.id === "org_A"),
    "o merchant que responde fees entra na lista",
  );
  assert.ok(
    !merchants.some((m) => m.id === "org_MORTO"),
    "o que não responde fica de fora",
  );
  assert.ok(calls.byId > 0, "o endpoint direto ainda é tentado antes da sonda");
});

test("quarentena: ID que não responde não é remartelado no ciclo seguinte", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-quar-"));
  const { clients, calls } = productionClients(["org_A"]);
  // TTL 0 força recarregar a cada chamada; sem quarentena, os IDs mortos
  // seriam consultados de novo em todo ciclo (o flood visto em produção).
  const cache = new MerchantCache(clients, 0, {
    store: new MerchantStore(dir),
    extraIds: ["org_A", "org_MORTO_1", "org_MORTO_2"],
    fallbackConcurrency: 1,
  });

  await cache.getAll();
  const mortosPrimeiroCiclo =
    (calls.fees.get("org_MORTO_1") ?? 0) + (calls.fees.get("org_MORTO_2") ?? 0);
  assert.equal(mortosPrimeiroCiclo, 2, "cada ID morto é sondado uma vez");

  await cache.getAll();
  await cache.getAll();
  const mortosDepois =
    (calls.fees.get("org_MORTO_1") ?? 0) + (calls.fees.get("org_MORTO_2") ?? 0);
  assert.equal(mortosDepois, 2, "quarentena de 10min impede a reconsulta");
  // O merchant vivo continua sendo atualizado normalmente.
  assert.ok((calls.fees.get("org_A") ?? 0) >= 3, "IDs vivos seguem sendo consultados");
});

test("vínculo manual do painel injeta o grupo no merchant e sobrevive ao reinício", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-bind-"));
  const store = new MerchantStore(dir);
  store.bindGroup("whatsapp", "120363@g.us", "org_A", "Grupo VIZZO");

  const { clients } = productionClients(["org_A"]);
  const cache = new MerchantCache(clients, 60_000, { store, extraIds: ["org_A"] });

  const merchants = await cache.getAll();
  const merchant = merchants.find((m) => m.id === "org_A");
  assert.equal(merchant?.linkGroups?.[0].groupId, "120363@g.us");
  assert.equal(merchant?.linkGroups?.[0].channel, "whatsapp");
  assert.equal(merchant?.linkGroups?.[0].active, true);

  // Novo processo lendo o mesmo DATA_DIR: o vínculo continua lá.
  const reloaded = new MerchantStore(dir);
  assert.equal(reloaded.bindings().length, 1);
  assert.equal(reloaded.bindings()[0].merchantId, "org_A");
  reloaded.unbindGroup("whatsapp", "120363@g.us");
  assert.equal(new MerchantStore(dir).bindings().length, 0, "desvincular também persiste");
});

test("Mutual toda fora: os vínculos manuais sozinhos mantêm os grupos cotando", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-only-bind-"));
  const store = new MerchantStore(dir);
  store.bindGroup("whatsapp", "120363@g.us", "org_3G8ynOqchbFQnpR34OWQ0zwDA8k", "Grupo VIZZO");

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
    { store, extraIds: [] },
  );

  const merchants = await cache.getAll();
  assert.equal(cache.snapshot().source, "bindings");
  assert.equal(merchants.length, 1);
  assert.equal(merchants[0].legalName, "VIZZO SOLUCOES EM PAGAMENTOS LTDA");
  assert.equal(merchants[0].linkGroups?.[0].groupId, "120363@g.us");
});

test("invalidate() força recarregar após vincular grupo no painel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cotamutual-inval-"));
  const store = new MerchantStore(dir);
  const { clients } = productionClients(["org_A"]);
  const cache = new MerchantCache(clients, 600_000, { store, extraIds: ["org_A"] });

  const antes = await cache.getAll();
  assert.equal(antes.find((m) => m.id === "org_A")?.linkGroups?.length ?? 0, 0);

  store.bindGroup("whatsapp", "120363@g.us", "org_A");
  cache.invalidate();

  const depois = await cache.getAll();
  assert.equal(depois.find((m) => m.id === "org_A")?.linkGroups?.[0].groupId, "120363@g.us");
});
