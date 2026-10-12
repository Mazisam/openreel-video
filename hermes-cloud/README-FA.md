# OpenReel → Hermes Cloud Connector 0.1.0

این پوشه را کنار `apps/` و `packages/`، در ریشهٔ فورک OpenReel قرار دهید.
این نسخه واقعاً ساخته و در محیط توسعه آزمایش شده است؛ هنوز در حساب Railway یا Vercel شما مستقر نشده است.

**مسیر اجرا:** هرمس روی VPS → HTTPS/MCP → صف پایدار روی Railway → ویرایش با OpenReel HeadlessHost → رندر FFmpeg روی Railway → شناسهٔ کار، وضعیت، لینک خصوصی MP4.

درخواست‌ها از هرمس ارسال می‌شوند؛ FFmpeg، Node renderer و Docker این بسته را روی VPS نصب یا اجرا نکنید. روی VPS فقط `tools/connect_hermes.py` و در صورت نیاز `tools/client.py` استفاده می‌شود. مدل و تولید تصویر/ویدیو با سرویس‌های موجود هرمس باقی می‌ماند؛ این connector تدوین می‌کند و خودش مدل زبانی یا تولیدکنندهٔ ویدیو را فراخوانی نمی‌کند.

## ۱. افزودن به فورک

فایل ZIP را روی کامپیوترتان باز کنید و پوشهٔ `hermes-cloud` را در ریشهٔ فورک کپی کنید. سپس از همان checkout:

```bash
git add hermes-cloud
git commit -m "Add Hermes MCP API, persistent queue and cloud MP4 renderer"
git push
```

این دستورها سورس استودیو SAAM را به GitHub منتقل نمی‌کنند. هیچ `.env`، توکن Google، فایل `accounts.json` یا کلید Jules را به فورک کپی نکنید.

سازگاری کد با سورس رسمی `Augani/openreel-video` در commit زیر آزمایش شده است:

```text
c9340465e5d37e684cc25bdbe746c4ccd45e165c
```

اگر فورک شما ساختار دیگری دارد، ابتدا build را روی کامپیوتر یا CI آزمایش کنید. ساخت همهٔ برنامهٔ OpenReel برای این backend لازم نیست؛ build فقط کد موردنیاز HeadlessHost را bundle می‌کند.

## ۲. استقرار backend روی Railway

1. در Railway یک پروژه بسازید و از `Deploy from GitHub repo` فورک خودتان را انتخاب کنید.
2. **Root Directory را ریشهٔ مخزن نگه دارید.** مسیر `hermes-cloud` را Root نکنید؛ Docker به سورس `packages/` نیاز دارد.
3. در Variables این مقدار را اضافه کنید:

```text
RAILWAY_DOCKERFILE_PATH=hermes-cloud/Dockerfile
```

4. یک Volume اختصاصی با Mount Path برابر `/data` متصل کنید. صف، پروژه‌ها، ورودی‌ها و خروجی‌ها باید در همین Volume باشند. بدون Volume، redeploy ممکن است داده‌ها را از بین ببرد.
5. دو کلید مستقل بسازید، فقط در ترمینال شخصی‌تان:

```bash
python3 -c 'import secrets; print("OPENREEL_SERVICE_TOKEN="+secrets.token_urlsafe(48)); print("OUTPUT_SIGNING_KEY="+secrets.token_urlsafe(48))'
```

6. مقدارها را در Variables Railway وارد کنید؛ کلیدها را در GitHub، صفحهٔ عمومی یا چت قرار ندهید. متغیرهای لازم:

```text
OPENREEL_SERVICE_TOKEN=<کلید اول>
OUTPUT_SIGNING_KEY=<کلید دوم>
RENDER_LOCATION=cloud
DATA_DIR=/data
PORT=8080
```

7. Healthcheck را `/health` قرار دهید؛ فقط **یک replica** اجرا کنید. صف این نسخه برای یک سرویس است، Redis و چند worker ندارد. Serverless/sleep را برای این صف فعال نکنید؛ درخواست render پس از پاسخ اولیه در پس‌زمینه ادامه پیدا می‌کند.
8. در Networking روی `Generate Domain` بزنید و پورت 8080 را انتخاب کنید. URL واقعی به شکل `https://YOUR-SERVICE.up.railway.app` می‌شود.
9. همین URL را در `PUBLIC_BASE_URL` قرار دهید و تغییرات را Deploy کنید. اگر `RAILWAY_PUBLIC_DOMAIN` توسط Railway تنظیم شود، سرویس از آن نیز استفاده می‌کند.
10. برای import از URL، `MEDIA_HOST_ALLOWLIST` را به میزبان‌های HTTPS لازم محدود کنید؛ برای مثال `storage.googleapis.com,*.googleusercontent.com`. همهٔ مقصدهای redirect هم باید مجاز باشند. آپلود فایل به allowlist نیاز ندارد.

فایل `railway.json` تنظیم‌های build و healthcheck را هم دارد. اگر از Config as Code استفاده می‌کنید، مسیر فایل را در تنظیم‌های Railway برابر `/hermes-cloud/railway.json` بگذارید. روش متغیر Dockerfile و تنظیم دستی بالا هم قابل استفاده است.

از سقف 1 vCPU و حدود 1 GB RAM برای اولین آزمون ۱۰ تا ۱۵ ثانیه‌ای شروع کنید و Metrics را ببینید؛ این عدد تخمین شروع است، اندازه‌گیری کار سنگین شما نیست. سرویس هزینهٔ CPU، RAM، ذخیره‌سازی و ترافیک Railway دارد و رایگان نامحدود نیست.

## ۳. بررسی آنلاین بدون رندر

در ترمینال شخصی، URL واقعی را جایگزین کنید:

```bash
export OPENREEL_CLOUD_URL='https://YOUR-SERVICE.up.railway.app'
read -rsp 'Cloud key: ' OPENREEL_SERVICE_TOKEN
echo
export OPENREEL_SERVICE_TOKEN
python3 hermes-cloud/tools/client.py status
```

در پاسخ باید `editing: OpenReel HeadlessHost`، `llm_calls: 0` و فهرست قابلیت‌ها را ببینید.

## ۴. اتصال هرمس روی VPS

فقط پوشهٔ `tools` یا دو فایل client/connector را به VPS انتقال دهید. سپس:

```bash
python3 /YOUR/PATH/connect_hermes.py --url https://YOUR-SERVICE.up.railway.app
```

کلید سرویس به‌صورت مخفی درخواست می‌شود. این ابزار ابتدا cloud را بررسی می‌کند؛ سپس نسخهٔ پشتیبان خصوصی از config و `.env` می‌گیرد و فقط یک ورودی MCP اضافه می‌کند. provider، مدل، MCP استودیو، ارتباط ژاپنی و کامنت‌های YAML حفظ می‌شوند. آزمون حفظ تنظیم‌ها داخل بسته هست.

این اسکریپت از PyYAML استفاده می‌کند، همان وابستگی نصب‌کنندهٔ فعلی SAAM. اگر `import yaml` روی Python انتخابی موجود نبود، اسکریپت را با Python محیط فعلی هرمس که PyYAML دارد اجرا کنید؛ هیچ نیاز به نصب FFmpeg یا Node روی VPS نیست.

در هرمس:

```text
/reload-mcp
```

اگر نسخهٔ درحال اجرای هرمس متغیر تازهٔ `.env` را reload نکرد، فقط فرایند هرمس را با روش فعلی مدیریت آن restart کنید؛ این بسته سرویس ژاپنی، Caddy، SAAM یا gateway را restart نمی‌کند.

ورودی حاصل در config:

```yaml
mcp_servers:
  openreel_cloud:
    url: "https://YOUR-SERVICE.up.railway.app/mcp"
    headers:
      Authorization: "Bearer ${OPENREEL_SERVICE_TOKEN}"
    timeout: 60
    connect_timeout: 30
```

در YAML فعلی فقط همان child را به `mcp_servers` موجود اضافه کنید؛ کل بلوک موجود را جایگزین نکنید. installer در فرمت‌های غیرمعمول YAML به‌جای بازنویسی گسترده متوقف می‌شود و merge دستی لازم است.

کلید cloud دسترسی کامل مالک دارد؛ به دوستان ندهید. دسترسی دوستان باید همچنان در SAAM کنترل شود. این نسخه چندمستأجری و سهمیهٔ جداگانه برای دوست‌ها نیست.

## ۵. رابط سبک روی Vercel — اختیاری

در Vercel همین فورک را Import کنید:

| تنظیم | مقدار |
|---|---|
| Root Directory | `hermes-cloud/console` |
| Framework Preset | Other |
| Build Command | خالی؛ Override روشن باشد |
| Install Command | خالی؛ Override روشن باشد |
| Output Directory | `.` |

console فقط HTML/JS است و کلید یا renderer داخل آن deploy نمی‌شود. URL نهایی console را در `CORS_ORIGINS` سرویس Railway قرار دهید، سپس Railway را redeploy کنید. console کلید را در حافظهٔ همان صفحه نگه می‌دارد و آن را در localStorage ذخیره نمی‌کند. منو انگلیسی است؛ روشن و تیره دارد.

در console آدرس Railway و کلید مالک را وارد کنید. پروژه بسازید، فایل آپلود کنید، actions را اعمال کنید و Render MP4 بزنید. این **کنسول اتصال** است؛ دکمهٔ Export رابط اصلی OpenReel هنوز به این renderer تغییر داده نشده است. هرمس از مسیر MCP این بسته مستقیماً به رندر ابری دسترسی دارد. برای offload همهٔ ابزارهای UI اصلی، نیاز به تطبیق renderer مرورگر OpenReel هست؛ این نسخه ادعای پشتیبانی از تمام آن موتور را ندارد.

Vercel در این چینش فقط رابط را میزبانی می‌کند؛ رندر MP4 در Railway انجام می‌شود. Vercel Sandbox در این نسخه پیاده‌سازی نشده است.

## ۶. پرامپت آماده برای هرمس

```text
از openreel_cloud برای تدوین و خروجی ابری استفاده کن.
ابتدا قابلیت‌ها را بخوان. ایدهٔ من را با مدل فعلی به طرح تدوین دقیق تبدیل کن؛
برای ساخت تصویر یا ویدیوی تازه از اتصال‌های موجود استفاده کن.
OpenReel cloud ابزار تولید هوش مصنوعی نیست؛ آنجا تدوین انجام می‌شود.
پروژهٔ افقی 1280×720 با 24fps بساز.
ورودی‌ها را با URL مجاز import کن یا برای فایل‌های موجود VPS از client.py upload استفاده کن.
تا پایان import صبر کن؛ media_id و revision را بگیر.
با actions پشتیبانی‌شده، کلیپ‌ها را بچین، برش بده، موسیقی و زیرنویس اضافه کن.
برای ویرایش و render از expected_revision فعلی استفاده کن.
هر درخواست منطقی فقط یک idempotency_key یکتا داشته باشد؛
در timeout ارسال، همان بدنه و کلید قبلی را استفاده کن، رندر تازه نساز.
render را ارسال کن؛ job ID را نگه دار و هر 5 تا 10 ثانیه status را بررسی کن.
وقتی completed شد، لینک MP4 را بده.
هیچ FFmpeg، رندر، Docker یا Export سنگین روی VPS اجرا نکن.
اگر ویژگی لازم پشتیبانی نمی‌شود، همان محدودیت را بگو و آن را بی‌صدا حذف نکن.
```

برای ترجیح شما می‌توان مرحلهٔ طراحی را با Opus انجام داد؛ انتخاب مدل در هرمس است و cloud connector توکن Antigravity را دریافت نمی‌کند.

## ۷. قرارداد API و MCP

همهٔ مسیرهای `/api/*` و `/mcp` به `Authorization: Bearer ...` نیاز دارند. `/health` عمومی است. فایل خروجی با لینک امضاشدهٔ یک‌ساعته قابل دریافت است؛ این لینک را مثل یک لینک خصوصی در نظر بگیرید.

| مسیر | نتیجه |
|---|---|
| `POST /api/projects` | پروژهٔ OpenReel و revision اولیه |
| `GET /api/projects` | فهرست پروژه‌ها |
| `GET /api/projects/:id` | دادهٔ پروژه و revision |
| `POST /api/media/upload?project_id=...&name=...` | آپلود binary؛ هدر `Idempotency-Key` لازم؛ job ID |
| `POST /api/jobs` | ارسال import/edit/render؛ job ID و status URL |
| `GET /api/jobs/:id` | queued/running/completed/failed/cancelled/interrupted |
| `POST /api/jobs/:id/cancel` | لغو و توقف worker |
| `DELETE /api/jobs/:id` | حذف کار پایان‌یافته و MP4 آن؛ کلید idempotency آن نیز آزاد می‌شود |
| `DELETE /api/projects/:id` | حذف پروژه، ورودی‌ها و خروجی‌ها؛ پروژهٔ دارای کار فعال حذف نمی‌شود |
| `GET /api/catalog` | schema دقیق actionهای قابل استفاده |
| `POST /mcp` | Streamable HTTP MCP با SDK رسمی |

MCP فقط شش ابزار سطح بالا دارد؛ catalog زمانی خوانده می‌شود که لازم باشد. به‌جای فرستادن همهٔ ابزارهای بزرگ OpenReel در هر پیام، مجموعهٔ کوچک قابل‌رندر ارائه می‌شود.

نمونهٔ ارسال رندر:

```json
{
  "kind": "render",
  "project_id": "UUID واقعی پروژه",
  "expected_revision": 3,
  "idempotency_key": "promo-render-version-001",
  "input": {"crf":22}
}
```

پاسخ اولیه `id`، `status: queued` و `status_url` دارد؛ **فایل هنوز آماده نیست**. پاسخ completed شامل `output_url` و metadata واقعی ویدیو می‌شود.

نمونهٔ ویرایش بعد از import:

```json
{
  "kind":"edit",
  "project_id":"UUID واقعی پروژه",
  "expected_revision":1,
  "idempotency_key":"promo-edit-version-001",
  "input":{"actions":[
    {"type":"track/add","params":{"trackType":"video","trackId":"footage"}},
    {"type":"clip/add","params":{"trackId":"footage","mediaId":"MEDIA_ID واقعی","clipId":"hero","startTime":0,"duration":8,"inPoint":0}},
    {"type":"audio/setVolume","params":{"clipId":"hero","volume":0.7}},
    {"type":"subtitle/add","params":{"text":"SAAM Studio","startTime":1,"endTime":4}}
  ]}
}
```

### قابلیت‌ها و محدودیت‌های روشن

- برش، split، حذف و جابه‌جایی کلیپ؛ تصویر/لوگو روی فیلم؛ contain/cover/stretch، موقعیت، اندازه و شفافیت؛ موسیقی و میکس صدا، volume و fade صوتی؛ زیرنویس ساده با متن فارسی/انگلیسی؛ H.264/AAC MP4 با faststart.
- track شمارهٔ صفر لایهٔ جلو است. کلیپ‌های تصویری روی یک track نباید هم‌پوشانی داشته باشند؛ برای overlay از track جدا استفاده کنید.
- فقط سرعت عادی؛ افکت GPU، motion/3D، transition، keyframe، ماسک، textClip و captionهای متحرک پیاده‌سازی نشده‌اند. به‌جای خروجی ناقص خطا می‌دهند.
- خروجی حداکثر 1080p یا 1080×1920، ۲۴/۲۵/۳۰fps، مدت حداکثر ۱۰ دقیقه، ۱۰۰ کلیپ، یک کار در حال اجرا و حداکثر ۳۲ کار در صف. سقف هر ورودی و MP4 خروجی 256 MiB است. فایل بزرگ‌تر باید کوتاه/تقسیم شود یا نسخهٔ بعدی با storage/limits بزرگ‌تر ساخته شود.
- سقف پیش‌فرض دادهٔ ذخیره‌شده 8 GiB است. داده‌ها خودکار پاک نمی‌شوند؛ خروجی‌های دانلودشده و پروژه‌های تمام‌شده را از API حذف کنید تا Volume پر نشود.
- حالت اصلی یک owner است. دریافت URL به allowlist، HTTPS، کنترل DNS و پین کردن IP عمومی، محدودیت redirect و حجم نیاز دارد؛ URL داخلی و metadata endpoint مجاز نیست.
- هر edit batch اتمی است؛ revision اشتباه رد می‌شود. رندر snapshot همان revision ارسال‌شده را می‌گیرد، حتی اگر بعداً پروژه ویرایش شود.
- در restart معمولی، صف و نتیجه‌ها حفظ می‌شوند. کار running پس از قطع ناگهانی `interrupted` می‌شود و خودکار تکرار نمی‌شود؛ ابتدا revision/result را بررسی کنید. ممکن است edit یا import پیش از قطع ذخیره شده باشد اما پاسخ نهایی ثبت نشده باشد.
- Docker سرویس پس از آماده‌سازی مالکیت Volume با کاربر `node` اجرا می‌شود. یک قفل filesystem مانع اجرای همزمان دو سرویس روی همان Volume می‌شود. image پایه با tag نسخهٔ اصلی Node آمده؛ پیش از rollout طولانی بهتر است digest مناسب معماری deployment خودتان را ثبت و pin کنید.

## ۸. آزمون‌ها و حد اعتبار ادعاها

داخل فورک، روی کامپیوتر توسعه یا CI دارای Node 22+، Python و FFmpeg:

```bash
cd hermes-cloud
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
python3 tools/test_connect.py
```

در محیط ساخت این بسته: **۱۸ آزمون Node و ۳ آزمون Python موفق**. آزمون end-to-end با کلاینت رسمی MCP انجام شد؛ ویدیوی واقعی ساخته شد، رنگ فریم‌های قبل/حین/بعد overlay بررسی شد، صدای واقعی و زیرنویس قابل‌دیدن تأیید شد. duplicate، conflict، restart و cancel هم آزموده شدند.

آزمون زندهٔ Railway/Vercel، Docker build و تست بصری console در مرورگر اجرا نشده‌اند. آخرین استقرار خصوصی شما، fork URL و کلید حساب‌های cloud در این محیط در دسترس نیست. این بسته به معنای deploy شدن حساب شما نیست.

## منابع اصلی

- OpenReel و HeadlessHost: https://github.com/Augani/openreel-video
- Railway Dockerfile path: https://docs.railway.com/builds/dockerfiles
- Railway Config as Code: https://docs.railway.com/config-as-code
- Railway public networking: https://docs.railway.com/networking/public-networking
- Vercel static builds: https://vercel.com/docs/builds
- Hermes HTTP MCP و متغیر محیطی: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp

مجوز connector: MIT. OpenReel در commit بررسی‌شده نیز MIT است. این بسته سورس اصلی OpenReel را همراه ندارد؛ build از سورس فورک شما استفاده می‌کند.
