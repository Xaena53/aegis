# Faz 3 — Hosted AdsPilot Mimarisi

Hedef: site sahibi hiçbir şey kurmadan bağlanır → Google hesabını tek tıkla yetkilendirir
→ Claude üzerinden reklamlarını yönetir → abonelik öder.

## Aşamalar

### 3a — Çok-kullanıcılı çekirdek + HTTP taşıma (BU AŞAMA)
- **Kimlik enjeksiyonu refactor'u:** global `.env` config yerine `AdsContext` (kullanıcı
  başına kimlik + kelepçeler). stdio modu aynen çalışır (env'den context üretir).
- **Remote MCP:** `StreamableHTTPServerTransport` + `Authorization: Bearer <api-key>`.
  Oturum başına, o kullanıcının context'ine bağlı McpServer örneği.
- **Kullanıcı deposu:** `node:sqlite` (native bağımlılık yok). Refresh token'lar
  AES-256-GCM ile şifreli (anahtar: `ADSPILOT_MASTER_KEY`).
- **/connect akışı:** web sayfası → Google consent (BİZİM GCP OAuth istemcimiz) →
  refresh token şifreli kaydedilir → kullanıcıya API anahtarı gösterilir →
  `claude mcp add --transport http https://.../mcp --header "Authorization: Bearer ..."`.

### 3b — Claude connectors uyumu
- MCP OAuth 2.1 keşfi (`/.well-known/oauth-authorization-server`, dynamic client
  registration) → claude.ai'da "bağlayıcı ekle" ile tek tık. Bearer yolu Claude Code
  için şimdiden yeterli; 3b claude.ai web kullanıcılarını açar.

### 3c — Ürünleştirme
- Abonelik: İyzico/Shopier (AnimeRank premium altyapısı deneyimi), kota sayaçları
  (kullanıcı başı günlük işlem), plan kademeleri (rapor-salt / yazma / ajans).
- **Google tarafı gereklilik:** üçüncü taraf hesaplara hizmet = Standard Access
  başvurusu + RMF (Required Minimum Functionality) uyumu. Basic Access (15K işlem/gün)
  sınırlı beta için yeterli — beta bu tavana göre kotalanır.

### 3d — Dağıtım
- VPS (<sunucu-ip>) + nginx + alan adı (karar: adspilot.* satın al ya da geçici
  `mcp.animerank.com.tr`). TLS zorunlu (bearer düz HTTP'de taşınamaz).
- Anthropic connectors dizini başvurusu.

## Güvenlik değişmezleri (her aşamada geçerli)
1. Yazmalar PAUSED-by-default + confirm kapısı — kullanıcı başına `writeEnabled`/bütçe tavanı.
2. Refresh token'lar yalnız şifreli saklanır; loglara asla yazılmaz.
3. API anahtarı = 32B rastgele, `ap_` önekli; hash'i saklanır (düz metin tek kez gösterilir).
4. Kullanıcılar arası izolasyon: context asla paylaşılmaz, oturum → tek kullanıcı.
