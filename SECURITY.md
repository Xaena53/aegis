# Güvenlik Politikası

Aegis, kullanıcıların Google Ads hesaplarına yazma erişimi olan ve **gerçek
para harcatabilen** bir MCP sunucusudur. Güvenlik bildirimlerini ciddiye alıyoruz.

## Açık bildirimi

Güvenlik açığını **herkese açık issue olarak açmayın.**

- GitHub **Security → Report a vulnerability** (private advisory) yolunu kullanın.
- Alternatif: depo sahibiyle GitHub üzerinden özel iletişime geçin.

Bildiriminizde şunlar yardımcı olur: etkilenen dosya/satır, somut bir yeniden
üretme adımı ve etkiyi anladığınız kadarıyla açıklama. İlk yanıtı makul sürede
vermeye çalışırız; düzeltme yayımlanana kadar ayrıntıyı gizli tutmanızı rica ederiz.

## Kapsam

Aşağıdakiler **açık** sayılır:

- Kiracı izolasyonunun kırılması (bir kullanıcının başkasının verisine/hesabına erişmesi)
- Kimlik doğrulama/yetkilendirme atlatma (bearer, oturum çerezi, OAuth akışı)
- **Onay kapılarının atlatılması** — insan onayı olmadan harcamayı artıran herhangi bir yol
- **Ağ güven kapısının atlatılması** — kapı temiz geçmeden onay isteminin gösterilmesi,
  ya da doğrulanamayan/okunamayan/çelişkili bir sinyalin kapıdan geçirilmesi (tek kayıt:
  8. maddedeki **kefilli** kademeli doğrulama; kefilsiz yükseltme yine açıktır)
- Güvenlik kelepçelerinin (bütçe tavanı, yazma izni) ajan tarafından gevşetilmesi
- Şifreli refresh token'ların ifşası
- Uzaktan kod çalıştırma, SSRF, servis dışı bırakma

Kapsam **dışı**: yalnız `.env`/master key'e zaten erişimi olan bir saldırganı
varsayan senaryolar; Google Ads API'nin kendi davranışları.

## Tasarım gereği güvenlik değişmezleri

Bir açık bildirirken bu değişmezlerden birini kırdığınızı gösterirseniz doğrudan
kabul edilir:

1. Kampanyalar **her zaman duraklatılmış** oluşturulur; hiçbir araç kendiliğinden
   harcama başlatmaz.
2. Yayına alma, bütçe **artışı** ve **yayındaki** kampanyaya reklam/pozitif kelime
   ekleme kullanıcının açık onayını gerektirir. Elicitation destekleyen istemcilerde
   onay doğrudan insandan alınır ve ajanın `confirm` değeri **dikkate alınmaz**.

   > **Bilinen sınır (tasarım gereği):** Elicitation desteklemeyen istemcilerde geri
   > uyumluluk için `confirm=true` kabul edilir — yani o istemcilerde onay ajan
   > aracılıdır. Sunucuyu kendi seçtiği bir istemciyle çalıştırabilen bir saldırgan
   > bu yola düşebilir. Bu, kimlik bilgilerine zaten erişimi olan bir tarafı
   > varsayar; yine de üretimde elicitation destekleyen istemci kullanın.
3. Belirsizlikte **kapalı arıza** — iki yüzeyde iki ayrı yöne, ikisi de güvenli taraf:
   - **Ads tarafı:** kampanya durumu okunamıyorsa (boş yanıt, eksik alan, tanınmayan
     değer) kampanya **yayında sayılır** ve **onay istenir**; onaysız yazma yapılmaz.
   - **Ağ güven kapısı:** `AEGIS_STEPUP` kapalıyken (**varsayılan**) doğrulanamayan/
     okunamayan/çelişkili sinyal insana **hiç sorulmaz** — işlem, onay istemi
     **gösterilmeden** reddedilir (bkz. 6-8). Kapının reddettiği anda gösterilen istem
     sayısı **sıfırdır**. `AEGIS_STEPUP` açıkken tek kayıt 8. maddedir: bozuk sinyali
     **çürütebilecek** ve o koşuda gerçekten bir şey **gözlemiş** bir halka gerçek kanaldan
     temiz döndüyse ret, o sinyali adıyla anan kademeli doğrulama istemine çevrilir —
     **kefil yoksa ret aynen durur ve istem sayısı yine sıfırdır.** Bu kaydın dışında
     kapıdaki belirsizlikte onay isteminin gösterildiği bir yol bulursanız bu bir
     **açıktır**, doğru davranış değil.
4. Bütçe tavanı ve yazma izni MCP üzerinden **yalnız okunur**; değişiklik yalnız
   insanın tarayıcı oturumundan yapılır (API anahtarı bu kapıyı açmaz).
5. `analyze_site` çıktısı güvenilmez dış içeriktir ve sınırlandırılmış bir blokta sunulur.
6. **Ağ güven kapısı, onay isteminden ÖNCE koşar.** Harcamayı artıran her araç, istem
   gösterilmeden önce GSMA Open Gateway / CAMARA halkalarından geçer (Nokia
   Network-as-Code; `src/networkTrust.ts`). Kapı reddederse **onay istemi hiç
   gösterilmez** ve hiçbir yazma yapılmaz. Kontrol, elicitation'lı **ve** `confirm`'lü
   kanalların ikisinden de önce koşar; çalınmış bir oturum zayıf kanala düşerek kapıyı
   atlayamaz.
7. **Kapının her halkasında kapalı arıza — "bilinmiyor" 0 değildir.** Okunamayan yanıt,
   yanıtsız uçnokta, fırlatan çağrı ve **çelişkili** sinyal redde gider; kapıdaki
   belirsizlik insana sorulmaz, işlem uygulanmaz. Çelişki, eksik bilgi kadar ciddiye
   alınır: ağ birden çok ülke bildirirse küme beklenen ülkeyi **içerse bile** reddedilir.
   Jeton tanımlı ama onaylayıcı numarası boşsa yine reddedilir. Bir halka **bilerek
   kapalıysa** hiç koşmaz ve bunu ize "kapalı" diye yazar — sessizce "temiz" sayılmaz.
8. **Kefalet ilkesi.** `AEGIS_STEPUP` açıkken (varsayılan **kapalı**) bozuk bir sinyalin
   reddi kademeli doğrulamaya çevrilebilir — ama yalnız o sinyali **çürütebilecek**
   türden bir halka gerçek kanaldan temiz dönmüşse. Sinyali çürütemeyen halka ona kefil
   olamaz (yalnız canlılık ölçen erişilebilirlik halkası ile simülasyon olan numara
   doğrulaması hiçbir kefil satırında yer almaz), ve hiçbir şey **gözlememiş** halka da
   kefil olamaz. Kefil yoksa ret durur. Yükseltme, istemin gerçekten gösterilebildiği
   kanalla sınırlıdır: elicitation yoksa yükseltme **redde** düşer. Hiçbir harcama tavanı
   indirilmez.
9. **Sır hijyeni.** Onaylayıcının numarası hiçbir yere tam yazılmaz; ağdan gelen **ham
   yanıt** — hata gövdesi, operatörün bildirdiği ülke listesi — ajana dönen metne, insana
   giden kanıt satırlarına ve karar günlüğüne girmez: yalnız türetilmiş karar ile
   yapılandırmadan gelen değerler çıkar. Operatör için stderr'e yazılan ayrıntıda numara
   biçimden bağımsız olarak redakte edilir; NAC jetonu hiçbir çıktıda görünmez.

## Yamalar

Güvenlik düzeltmeleri `main` dalına uygulanır. Bu proje AGPL-3.0 lisanslıdır;
kendi kopyanızı çalıştırıyorsanız güncellemeleri takip etmek sizin sorumluluğunuzdadır.
