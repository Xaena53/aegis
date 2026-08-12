# VPS dağıtımı — adım adım

Bu klasördeki dosyalar denetimde bulunan tuzakları önceden kapatır. Sırayı bozma.

## 0. Ön koşullar

| Gereksinim | Neden |
|---|---|
| **Node ≥ 22.13** | Hosted mod `node:sqlite` kullanır (Node 22.5'te geldi, 22.13'te bayraksız). Ubuntu/Debian'ın apt paketi 18/20'dir → `npm run serve` ilk import'ta çöker. |
| **Alan adı + TLS** | Bearer API anahtarları ve OAuth kodları düz HTTP'de taşınamaz. |
| **Google Ads Basic Access** | Test Access seviyesinde GERÇEK kullanıcı hesapları çalışmaz — hosted beta açılamaz. |

```bash
# Node 22.13 (nodesource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs && node -v   # v22.13+ olmalı
```

## 1. Kullanıcı ve dizin

```bash
sudo useradd --system --home /opt/adspilot --shell /usr/sbin/nologin adspilot
sudo mkdir -p /opt/adspilot && sudo chown adspilot:adspilot /opt/adspilot
# NOT: 'data' dizini KLONDAN SONRA oluşturulur — git clone boş olmayan dizine yazmaz.
```

## 2. Kodu kur

```bash
sudo -u adspilot -H git clone <repo> /opt/adspilot
cd /opt/adspilot
sudo -u adspilot -H mkdir -p data          # klondan SONRA
sudo -u adspilot -H npm ci                 # -H şart: HOME yoksa npm /root/.npm'e yazmaya çalışır
sudo -u adspilot -H npm run build
```

## 3. Yapılandırma (`.env`)

```bash
sudo -u adspilot cp .env.example .env
sudo -u adspilot node -e "console.log('ADSPILOT_MASTER_KEY='+require('crypto').randomBytes(32).toString('hex'))"
sudo nano /opt/adspilot/.env
sudo chmod 600 /opt/adspilot/.env      # master key burada
```

Zorunlu alanlar:

```ini
GOOGLE_ADS_DEVELOPER_TOKEN=...
GOOGLE_ADS_CLIENT_ID=...
GOOGLE_ADS_CLIENT_SECRET=...
ADSPILOT_MASTER_KEY=<64 hex>
ADSPILOT_DB=/opt/adspilot/data/adspilot.db
ADSPILOT_PUBLIC_URL=https://adspilot.ornek.com
ADSPILOT_ALLOWED_HOSTS=adspilot.ornek.com
ADSPILOT_SOURCE_URL=https://github.com/KULLANICIN/deponun-adresi
PORT=8787
```

> **⚠ SATIR-İÇİ YORUM YAZMA.** Bu dosyayı systemd (`EnvironmentFile`) ve Docker
> (`--env-file`) de okur; ikisi de yalnız SATIR BAŞINDAKİ `#` işaretini yorum sayar.
> `ADSPILOT_ALLOWED_HOSTS=alan.com   # not` yazarsan yorum değerin parçası olur,
> Host eşleşmez ve **tüm MCP trafiği 403 alır** — teşhisi zor bir arızadır.
> Açıklamayı ayrı satıra yaz. Kontrol: `systemctl show adspilot -p Environment`
>
> **AGPL:** `ADSPILOT_SOURCE_URL` KENDİ deponu göstermeli. Kodu değiştirip
> dağıtıyorsan varsayılan (upstream) adres §13 yükümlülüğünü karşılamaz.

> **`ADSPILOT_DB` mutlak yol olmalı.** Boş bırakılırsa dosya çalışma dizininde
> aranır; `ProtectSystem=strict` altında orası salt-okunurdur → servis açılışta
> çöker ve 5 saniyede bir yeniden başlar.

Sunucu eksik/geçersiz yapılandırmada **başlamaz** (fail-fast) — `/health` yeşil
yanıp seni yanıltmaz.

## 4. Google Cloud OAuth

> **⚠ İstemci tipi "Web application" olmalı — "Desktop app" DEĞİL.**
> Desktop app tipinde "Authorized redirect URIs" alanı düzenlenemez (yalnız
> loopback kabul eder); hosted mod **hiç açılamaz**, `/connect` akışı
> `redirect_uri_mismatch` ile biter. Yerel stdio kullanımı (`npm run auth`)
> için Desktop app doğrudur — **ikisi ayrı istemci olmalıdır**.

> **⚠ 7 gün tuzağı: OAuth doğrulaması.** `adwords`, Google'ın *hassas* kapsamıdır.
> Uygulama "Testing" modundayken Google refresh token'ları **7 günde geçersiz
> kılar** (ve en fazla 100 test kullanıcısı olur) — hosted beta kullanıcılarının
> bağlantısı haftada bir sessizce ölür (`invalid_grant`). Gerçek kullanıcıya
> açmadan önce consent screen'i **"In production"a alıp doğrulamayı başlat.**
> Bu, Basic Access ile aynı ağırlıkta bir ön koşuldur.

Yetkili yönlendirme URI'sine **birebir** şunu ekle:

```
https://adspilot.ornek.com/oauth/callback
```

## 5. Servis

```bash
sudo cp deploy/adspilot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now adspilot
sudo systemctl status adspilot
journalctl -u adspilot -f
```

> **TEK INSTANCE.** Oturumlar ve hız sınırı sayaçları süreç belleğindedir.
> pm2 cluster / birden çok replika → `404 session_not_found` döngüsü ve
> hız sınırının worker sayısınca çarpılması. Ölçeklemek gerekirse önce
> oturum+sayaç durumu Redis'e taşınmalı.

## 6. nginx + TLS

Sertifika **önce** alınmalı: örnek dosya `/etc/letsencrypt/...` yollarına işaret
eder, o dosyalar yokken `nginx -t` başarısız olur ve certbot da devam edemez.

```bash
# 1) Sertifikayı bağımsız al (nginx'i değiştirmeden)
sudo apt-get install -y certbot
sudo certbot certonly --webroot -w /var/www/html -d adspilot.ornek.com

# 2) Sertifika ARTIK VARKEN örnek yapılandırmayı yerleştir
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/adspilot
sudo nano /etc/nginx/sites-available/adspilot        # alan adını düzenle
sudo ln -s /etc/nginx/sites-available/adspilot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> **`proxy_set_header Host $host;` satırını silme.** O olmadan upstream'e
> `Host: 127.0.0.1` gider, DNS rebinding koruması eşleşmez ve **tüm MCP
> trafiği 403 alır**. "Hiçbir şey çalışmıyor" şeklinde görünen, teşhisi zor
> bir arızadır.

## 7. Doğrulama

```bash
curl -s https://adspilot.ornek.com/health                     # {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://adspilot.ornek.com/mcp                      # 401 bekleniyor
```

Tarayıcıdan `https://adspilot.ornek.com/connect` → Google ile bağlan →
API anahtarını al → Claude Code'a ekle:

```bash
claude mcp add --transport http adspilot https://adspilot.ornek.com/mcp \
  --header "Authorization: Bearer ap_..."
```

## 8. Yedekleme

WAL modunda `.db` dosyasını **canlıyken kopyalamak bozuk yedek verir** (veriler
`.db-wal`'de olabilir). Doğru yol `.backup` komutudur: tek, tutarlı bir dosya
üretir — üç dosyayı elle kopyalamaya gerek kalmaz.

```bash
sudo apt-get install -y sqlite3                 # CLI kurulu değil
sudo mkdir -p /yedek && sudo chown adspilot:adspilot /yedek
sudo -u adspilot -H sqlite3 /opt/adspilot/data/adspilot.db \
  ".backup '/yedek/adspilot-$(date +%F).db'"
```

`ADSPILOT_MASTER_KEY`'i veritabanından **ayrı** bir yerde sakla: ikisi bir arada
çalınırsa şifreleme anlamsız kalır, anahtar kaybolursa yedek işe yaramaz.

## 9. Docker alternatifi

> **⚠ Aynı `.env`'i kullanma.** VPS için hazırlanan dosyada
> `ADSPILOT_DB=/opt/adspilot/data/...` var; `--env-file` bunu konteynerin
> `ENV ADSPILOT_DB=/data/adspilot.db` değerinin ÜZERİNE yazar, o yol konteynerde
> yoktur ve süreç açılışta ölür (`--restart` ile sonsuz döngü). Docker için
> ayrı bir dosya tut ve `ADSPILOT_DB` satırını **hiç yazma** (imaj varsayılanı doğrudur).

```bash
docker build -t adspilot .
grep -v '^ADSPILOT_DB=' .env > .env.docker      # DB yolunu imaja bırak
docker run -d --name adspilot -p 127.0.0.1:8787:8787 \
  --env-file .env.docker -v adspilot-data:/data --restart unless-stopped adspilot
```

> Bind-mount (`-v /host/dizin:/data`) kullanırsan sahiplik kopyalanmaz;
> `sudo chown -R 1000:1000 /host/dizin` gerekir (konteyner `node` kullanıcısıyla çalışır).
