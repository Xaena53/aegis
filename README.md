# AdsPilot — Google Ads MCP Sunucusu

Claude'u (veya herhangi bir MCP istemcisini) Google Ads hesabına bağlar: raporlama **ve** güvenlik kapılı kampanya yönetimi. Google'ın resmi MCP'sinden farkı: **yazma erişimi** var (kampanya oluşturma, bütçe, anahtar kelime, RSA reklam), ama her tehlikeli adım korumalı:

- Kampanyalar **her zaman PAUSED** oluşturulur — asla doğrudan yayına çıkmaz.
- Ülke hedefleme **zorunlu** (`countryCodes`) — dünya-geneli kazara yayın engellenir.
- Paylaşımlı bütçeye dokunulmaz (çok kampanyayı birden etkileme koruması).
- Yayına alma (`ENABLED`) açık kullanıcı onayı ister (`confirm=true` kapısı).
- Günlük bütçe tavanı: `ADSPILOT_MAX_DAILY_BUDGET` üzerindeki istekler reddedilir.
- Tüm yazma araçları `ADSPILOT_WRITE_ENABLED=0` ile toptan kapatılabilir.

## Araçlar

| Araç | Tür | Ne yapar |
|---|---|---|
| `analyze_site` | okuma | **"Siteni bağla":** URL → başlık/meta/H1-H3/JSON-LD/menü/metin çıkarımı → kelime+RSA üretimi için hammadde (kimlik bilgisi gerektirmez, SSRF korumalı) |
| `list_accounts` | okuma | Erişilebilir müşteri hesaplarını listeler |
| `campaign_performance` | okuma | Son N gün kampanya özeti (maliyet, tıklama, dönüşüm, CTR) |
| `keyword_performance` | okuma | Anahtar kelime bazlı performans |
| `run_gaql` | okuma | Ham GAQL sorgusu |
| `create_search_campaign` | yazma | Bütçe + kampanya (PAUSED) + ülke hedefleme (zorunlu) + reklam grubu + kelimeler |
| `create_responsive_search_ad` | yazma | Reklam grubuna RSA ekler |
| `add_keywords` | yazma | Anahtar kelime / negatif kelime ekler (reklam grubu) |
| `add_campaign_negative_keywords` | yazma | Kampanya seviyesi negatif kelime (tüm reklam gruplarını kapsar) |
| `update_campaign_budget` | yazma | Günlük bütçe günceller (tavan kelepçeli) |
| `set_campaign_status` | yazma | Yayına al / duraklat (ENABLED onay kapılı) |

## Kurulum

```bash
npm install
npm run build
npm test        # birim testleri (saf yardımcılar: guard'lar, retry, tarih aralığı)
```

Geçici API hataları (UNAVAILABLE, kota) okuma yollarında üstel geri çekilmeyle otomatik tekrar denenir; **mutasyonlar bilerek retry'sız** — tekrar deneme çift kayıt oluşturabilir.

### 1. Faz 0 — Google tarafı (bir kere yapılır)

1. **MCC (yönetici) hesabı aç:** https://ads.google.com/home/tools/manager-accounts/ — developer token yalnızca MCC'den alınır.
2. **Developer token al:** MCC > Tools & Settings > API Center. Başlangıçta **Test Access** verilir (sadece test hesaplarında çalışır). Gerçek hesaplar için **Basic Access** başvurusu yap (aynı ekrandan; kullanım amacını dürüst yaz: "kendi hesaplarımın raporlama ve yönetimi"). Onay genelde birkaç gün sürer.
3. **Google Cloud projesi:** https://console.cloud.google.com → yeni proje → "Google Ads API"yi etkinleştir.
4. **OAuth istemcisi:** APIs & Services > Credentials > Create Credentials > OAuth client ID > **Desktop app**. Client ID + Secret'ı al. (Consent screen'de test kullanıcısı olarak kendi Gmail'ini ekle.)
5. `.env.example` → `.env` kopyala, değerleri doldur.
6. **Refresh token üret:** `npm run auth` → tarayıcıda izin ver → çıkan satırı `.env`'e yapıştır.

### 2. Claude Code'a bağla

```bash
claude mcp add adspilot -- node C:/AdsPilot/dist/index.js
```

veya proje kökündeki `.mcp.json` zaten kayıtlı — `C:\AdsPilot` içinde çalışırken otomatik yüklenir.

## Güvenlik modeli

Yazma zinciri her zaman şu sırayla ilerler:

```
taslak oluştur (PAUSED) → reklam metni ekle → kullanıcıya özet göster → açık onay → ENABLED
```

Ajan `set_campaign_status(status=ENABLED)` çağrısını `confirm=true` olmadan yapamaz; araç reddeder ve önce kullanıcıya bütçe/kelime/metin özetini göstermesini söyler.

## "Siteni bağla" akışı (Faz 2)

```
analyze_site(url) → Claude ürün/hizmeti anlar → kelime + RSA metni üretir
  → kullanıcı onayı → create_search_campaign (PAUSED) → create_responsive_search_ad
  → son onay → set_campaign_status(ENABLED)
```

Tasarım ilkesi: MCP sunucusu *gerçek çıkarır*, yaratıcı işi (kelime seçimi, metin yazımı)
istemci taraftaki model yapar — böylece sunucu deterministik ve test edilebilir kalır.

## Yol haritası

- **Faz 3 — Hosted:** remote MCP (OAuth ile tek tık bağlantı), abonelik, Anthropic connectors dizini, Meta/TikTok genişlemesi.
