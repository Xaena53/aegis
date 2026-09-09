// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 3 — src/tools/write.ts gözcüleri.
 *
 * Üç bulgu, üç ayrı sözleşme:
 *   1) Kelepçe onaydan SONRA da geçerlidir — canlı kampanyaya ekleme yollarında da.
 *   2) Okunamayan bir bütçe 0 DEĞİLDİR; ne insana ne ajana kesin bir 0 olarak sunulur.
 *   3) Yorumlar kodun bugünkü hâlini anlatır; iki yönlü gözcü hem bayat cümleyi hem
 *      cümlenin dayandığı kapının kaybolmasını yakalar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { sahteContext } from "./helpers/harness.js";

const MUSTERI = "1234567890";
const KAMPANYA = "24120539226";
const REKLAM_GRUBU = "200057393038";

/**
 * Elicitation bildiren istemci. `istemAcikken`, insan istemi AÇIKKEN koşar: gerçek
 * hayatta bu pencere on dakikaya kadar sürüyor ve hesap sahibinin ayarlar sayfasından
 * yazmayı kapatması tam olarak burada oluyor.
 */
async function elicitli(
  ctx: any,
  karar: "accept" | "decline" = "accept",
  istemAcikken?: () => void
) {
  const sorulanlar: string[] = [];
  const client = new Client({ name: "faz3-write", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req: any) => {
    sorulanlar.push(String(req.params.message));
    istemAcikken?.();
    if (karar === "accept") return { action: "accept", content: { onay: true } };
    return { action: karar };
  });
  const server = buildServer(() => ctx);
  const [ist, sun] = InMemoryTransport.createLinkedPair();
  await server.connect(sun);
  await client.connect(ist);
  return { client, sorulanlar };
}

async function cagir(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args });
  return String(res.content?.[0]?.text ?? "");
}

/** Canlı (ENABLED) kampanya + okunabilir bütçe. */
const CANLI: Array<[RegExp, any[]]> = [
  [/FROM ad_group\b/, [{ campaign: { id: 7, name: "Canlı", status: 2 }, ad_group: { status: 2 } }]],
  [/campaign_budget\.amount_micros/, [{ campaign_budget: { amount_micros: 25_000_000 } }]],
];

const RSA_ARG = {
  customerId: MUSTERI,
  adGroupId: REKLAM_GRUBU,
  finalUrl: "https://ornek.com",
  headlines: ["Bir", "Iki", "Uc"],
  descriptions: ["Aciklama bir", "Aciklama iki"],
  confirm: true,
};

const KELIME_ARG = {
  customerId: MUSTERI,
  adGroupId: REKLAM_GRUBU,
  keywords: ["ayakkabi", "spor ayakkabi"],
  confirm: true,
};

/* ── BULGU 1: kelepçe onaydan sonra canlı-kampanya yollarında da okunur ──────── */

test("KELEPÇE: add_keywords, onay beklerken yazma KAPATILDIYSA canlı kampanyaya yazmaz", async () => {
  const { ctx, rec } = sahteContext({ queries: CANLI });
  const { client, sorulanlar } = await elicitli(ctx, "accept", () => {
    // Hesap sahibinin panik anahtarı: istem açıkken yazma kapatılıyor.
    ctx.config.writeEnabled = false;
  });

  const out = await cagir(client, "add_keywords", KELIME_ARG);

  assert.equal(sorulanlar.length, 1, "insana gerçekten sorulmuş olmalı");
  assert.match(out, /YAZMA KAPATILDI/, "kelepçe onaydan sonra da geçerli olmalı");
  assert.equal(rec.mutations.length, 0, "onay alınmış olsa bile hiçbir yazma gitmemeli");
});

test("KELEPÇE: create_responsive_search_ad, onay beklerken yazma KAPATILDIYSA reklam eklemez", async () => {
  const { ctx, rec } = sahteContext({ queries: CANLI });
  const { client, sorulanlar } = await elicitli(ctx, "accept", () => {
    ctx.config.writeEnabled = false;
  });

  const out = await cagir(client, "create_responsive_search_ad", RSA_ARG);

  assert.equal(sorulanlar.length, 1);
  assert.match(out, /YAZMA KAPATILDI/);
  assert.equal(rec.mutations.length, 0);
});

/**
 * KARŞI KUTUP. Kelepçe YERİNDE dururken aynı iki yol akıcı kalmalı — yoksa yukarıdaki
 * iki gözcü "her şeyi reddeden" bir kapıyla da yeşil olurdu.
 */
test("KELEPÇE KIMILDAMADIYSA: onaylanan ekleme normal biçimde uygulanır", async () => {
  const { ctx, rec } = sahteContext({ queries: CANLI });
  const { client } = await elicitli(ctx, "accept");

  const kelime = await cagir(client, "add_keywords", KELIME_ARG);
  assert.match(kelime, /anahtar kelime eklendi/);

  const rsa = await cagir(client, "create_responsive_search_ad", RSA_ARG);
  assert.match(rsa, /RSA oluşturuldu/);

  assert.equal(rec.mutations.length, 2, "kelepçe kımıldamadıysa iki yazma da geçmeli");
});

/* ── BULGU 2: okunamayan eski bütçe 0 olarak sunulmaz ────────────────────────── */

function butceSatiri(amount: unknown): Array<[RegExp, any[]]> {
  return [
    [
      /campaign_budget\.explicitly_shared/,
      [
        {
          campaign: { name: "K" },
          campaign_budget: { resource_name: "r", explicitly_shared: false, amount_micros: amount },
        },
      ],
    ],
  ];
}

for (const [ad, deger] of [
  ["null", null],
  ["boş dizge", ""],
  ["alan hiç yok", undefined],
  ["boolean", true],
] as Array<[string, unknown]>) {
  test(`OKUNAMADI: amount_micros ${ad} iken eski bütçe 0 olarak gösterilmez`, async () => {
    const { ctx, rec } = sahteContext({ queries: butceSatiri(deger) });
    const { client, sorulanlar } = await elicitli(ctx, "accept");

    const out = await cagir(client, "update_campaign_budget", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      newDailyBudget: 120,
    });

    assert.equal(sorulanlar.length, 1, "okunamayan eski bütçe her hâlükârda onay ister");
    assert.match(sorulanlar[0], /Mevcut bütçe OKUNAMADI/, "insana okunamadığı SÖYLENMELİ");
    assert.doesNotMatch(sorulanlar[0], /Mevcut: 0 /, "okunamayan bütçe kesin bir 0 gibi sunulamaz");
    assert.doesNotMatch(sorulanlar[0], /günlük artış/, "ölçülmemiş bir artış rakamı uydurulamaz");
    assert.doesNotMatch(out, /: 0 →/, "araç çıktısı da 'eski bütçe 0'dı' dememeli");
    assert.match(out, /OKUNAMADI/, "çıktı okunamadığını açıkça yazmalı");
    assert.equal(rec.mutations.length, 1, "onaylandıysa yazma yine de yapılır");
  });
}

test("OKUNABİLİR eski bütçe hâlâ sayı olarak gösterilir (gözcü her şeyi OKUNAMADI ilan etmiyor)", async () => {
  const { ctx } = sahteContext({ queries: butceSatiri(50_000_000) });
  const { client, sorulanlar } = await elicitli(ctx, "accept");

  const out = await cagir(client, "update_campaign_budget", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    newDailyBudget: 400,
  });

  assert.match(sorulanlar[0], /Mevcut: 50 → Yeni: 400/);
  assert.match(sorulanlar[0], /\+350\.00/);
  assert.match(out, /50 → 400/);
  assert.doesNotMatch(out, /OKUNAMADI/);
});

/* ── BULGU 3: iki yönlü yorum gözcüsü ────────────────────────────────────────── */

const KAYNAK = readFileSync(new URL("../src/tools/write.ts", import.meta.url), "utf8");

/** set_campaign_status'un ENABLED dalı — iki yönlü gözcünün tarama alanı. */
function enabledDali(): string {
  const bas = KAYNAK.indexOf('if (status === "ENABLED") {');
  assert.ok(bas > 0, "set_campaign_status'un ENABLED dalı bulunamadı — gözcü kör kaldı");
  const son = KAYNAK.indexOf("await ctx.mutateWithRetry", bas);
  assert.ok(son > bas, "ENABLED dalının sonu bulunamadı");
  return KAYNAK.slice(bas, son);
}

test("YORUM (yön 1 — bayatlık): 'daily okunamayan bütçeyi 0 yapar' cümlesi kodda kalmamalı", () => {
  const dal = enabledDali();
  assert.doesNotMatch(
    dal,
    /turns an unreadable budget into 0/i,
    "kaldırılmış `?? 0` davranışını anlatan bayat cümle geri gelmiş"
  );
  assert.doesNotMatch(
    dal,
    /the ceiling check refuses it anyway/i,
    "tavan kontrolü o dalda hiç çalışmıyor; gerekçe bayat"
  );
});

test("YORUM (yön 2 — kod kayması): cümlenin dayandığı okunamazlık kapısı yerinde duruyor", () => {
  const dal = enabledDali();
  const kapi = dal.indexOf("!Number.isFinite(Number(micros))");
  const dailyAtama = dal.indexOf("const daily = Number(micros) / 1e6");
  assert.ok(kapi > 0, "okunamayan bütçeyi ANINDA reddeden kapı kayboldu");
  assert.ok(dailyAtama > kapi, "`daily`, okunamazlık kapısından SONRA hesaplanmalı");
  // Yeni yorum, bugünkü gerekçeyi taşımalı: `daily` bu noktada zaten sonlu.
  assert.match(
    dal,
    /already been read and is finite/i,
    "yorum, `daily`nin bu noktada sonlu olduğunu söylemeli"
  );
  assert.match(dal, /mikrodanTutar/, "ham alanın ayrıca okunma gerekçesi yorumda adıyla geçmeli");
});

test("YORUM (davranışsal kanıt): okunamayan bütçe `daily`ye HİÇ ulaşmaz — akış önce reddeder", async () => {
  const { ctx, rec } = sahteContext({
    queries: [
      [/campaign_budget\.amount_micros/, [{ campaign: { name: "K" }, campaign_budget: { amount_micros: null } }]],
      [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
      [/FROM campaign_criterion/, []],
    ],
  });
  const { client, sorulanlar } = await elicitli(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });

  assert.match(out, /günlük bütçesi okunamadı/);
  assert.equal(sorulanlar.length, 0, "okunamayan bütçede insana hiç sorulmaz");
  assert.equal(rec.mutations.length, 0);
});
