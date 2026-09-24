# AGENTS.md

專案共享長期記憶。任務快照請見 `docs/Handover.md`。

## agent 規範採用

- `sdd-workflow`：採用
- `feature-wrapup`：採用
- `git-workflow`：採用

## Project Purpose

瀏覽器擴充套件「Authenticator」——在瀏覽器中產生 2-Step Verification (OTP) 驗證碼。
fork 自 [Authenticator-Extension/Authenticator](https://github.com/Authenticator-Extension/Authenticator)，本分支相對 upstream 基準 `9d9660b` 的差異：**加密改用原生 Web Crypto AES-GCM**（取代無認證的 crypto-js CBC，`83a0996`）、**host-bound autofill**（upstream 以分頁標題做子字串比對，`82a3413`）、**雲端備份需先設主密碼**（`320930f`）、**Dropbox OAuth 改 Authorization Code + PKCE、擴充內零 secret**（upstream 的 Drive refresh 把 client_secret 明文放進 URL query，`ee3528a`）、**QR 解碼移進 background**（注入分頁的程式碼 ~1.9 MiB → ~55 KiB，`b1a32fb`）、QR 函式庫由並存的 qrcode-reader/jsqr 統一為 @zxing/library、import 頁面重新設計、CSS custom-property design system。（Google Drive 備份已於 2026-07 移除，OneDrive 為停用 placeholder——見 Security / Constraints。）
⚠ **Advisor 安全建議與 Argon2id 金鑰衍生是 upstream 既有功能**（`9d9660b` 已含 `src/models/advisor.ts` 與 `argon2-browser`），2026-07-28 查證更正——勿再當成本分支賣點。

## Repo Map

- `src/components/` — Vue 元件。`Popup/` 為主彈窗各頁面，`Import/` 為匯入流程，`common/` 為共用 input 元件。
- `src/models/` — 核心邏輯：`otp.ts`、`encryption.ts`、`key-utilities.ts`、`backup.ts`、`credentials.ts`、`storage.ts`、`migration.ts`、`advisor.ts`、`permission.ts`、`settings.ts`。
- `src/store/` — Pinia setup stores（Accounts、Backup、Advisor、Permissions、Menu、Notification、Qr、Style、CurrentView；2026-07-17 自 Vuex 4 遷移）＋ `i18n.ts`（非 store，是 `loadI18nMessages()` loader）。async 初始化模式：store 暴露 `init()`，popup.ts／permissions.ts 於 `app.mount()` 前 await。
- `src/definitions/` — 型別宣告 `.d.ts`。
- `src/test/` — Mocha 測試。
- `sass/` — 樣式，以 CSS custom properties (design tokens) 為基礎（`_tokens.scss`、`_ui.scss`）；模組系統為 `@use`（2026-07-12 遷移，勿再寫 `@import`，Dart Sass 3.0 將移除）。
- `scripts/build.sh` — 統一建置入口；`scripts/test-runner.js` — 測試 runner。
- `webpack-loaders/vue-svg-loader.js` — vendor 的 SVG→Vue 元件 loader（MIT，取代已死的 vue-svg-loader 套件；含 Windows 路徑修正 `split(/[/\\]/)`，勿改回 `split("/")`）。
- `_locales/` — i18n（`en/messages.json` 為 key 來源；Crowdin 已於 fork 後停用，各語系改為手動翻譯維護）。

## Commands

> 建置走 `bash scripts/build.sh`，Windows 需在**完整 coreutils 的 Git Bash** 下執行（PowerShell 直跑 `npm test` 會在 pretest 報 `'bash' is not recognized`；精簡版 Git Bash 缺 `cat`/`tr`/`rm` 也會失敗——都不是測試本身的錯）。build 內建 prettier 會對全 repo 做 EOL 正規化（大量檔案顯示 modified 但內容 diff 為零），commit 一律精確 `git add <檔案>`，勿 `add -A`。

- `npm run dev:chrome` — watch 建置 Chrome 版（已修復：webpack.watch.js 不再引用 `webpack-extension-reloader`，無 auto-reload，rebuild 後手動 reload 擴充；每次 rebuild 會自動跑 test-runner）
- `npm run chrome` / `firefox` / `edge` / `prod` — 各 target 建置（`prod` 會因 `src/models/credentials.ts` 為空（OAuth 憑證已移除）而**中止**；`chrome`/`test` 只警告仍可建。雲端備份功能因憑證空而無法實連）
- `npm test` — 先 `pretest` 建 test bundle，再 `node scripts/test-runner.js`（puppeteer 載入實際 extension + 瀏覽器內 mocha，`headless:false` 需 GUI）
- 全新 checkout 需先 `npm ci`（約 2 分鐘）。npm 12+ 預設擋 install scripts，Chromium **不會**自動下載——首次跑測試前需 `npm install-scripts approve puppeteer` + `npm rebuild puppeteer`（2026-07-27 實測踩過）。`chrome/`、`js/`、`css/` 為 gitignored build 產物
- `node scripts/check-i18n.js` — 驗證所有 `_locales` 語系 key 集與 en 一致（CI `i18n` workflow 於 push/PR 會跑；不一致即 fail）

## CI / Release（GitHub Actions，2026-07-11 現代化）

- `main.yml`：style checks（prettier，版本隨 package.json，2026-07-12 起為 3.x）＋ build chrome/firefox ＋ run-tests。**run-tests 用 puppeteer 內建 Chrome for Testing ＋ `xvfb-run`，勿改回系統 Chrome**——Chrome 137+ 正式版永久移除 `--load-extension`，extension 載不進去（症狀：`net::ERR_BLOCKED_BY_CLIENT`，2026-07-11 已踩過）。
- `release.yml`：推 **annotated** `v*` tag（`git tag -a vX.Y.Z -m "..."`）→ `npm run chrome` → 打包 `chrome/` 成 ZIP → `gh release create --notes-from-tag`（tag 訊息＝release 內文；**lightweight tag 無訊息會失敗**）。零外部 secret（內建 GITHUB_TOKEN）。上游舊 release/tagging workflows（依賴 upstream secrets＋archived actions，fork 上從未觸發）已於 2026-07-11 刪除，勿復活。
- `codeql-analysis.yml`：codeql-action@v3、`languages: javascript-typescript`、job-level 最小權限。`i18n.yml`：key parity。
- actions 版本基準：checkout@v5、setup-node@v5（Node 24 世代；v4 會產生 Node 20 deprecation annotation）。setup-node 帶 `node-version: 22`＋`cache: npm`。
- release 資產名：`OTPilot-Authenticator-chrome-<tag>.zip`（連字號——GitHub 會把資產檔名的空白轉成點）。release.yml 內 `gh release create` 前必須 `git fetch --force` 補回 tag 註解（actions/checkout#290 會把 annotated tag 攤平，否則 notes 變成 commit message，2026-07-11 已踩過）。
- manifest 的 `key` 欄位＝公鑰（固定 extension ID 供 Dropbox OAuth redirect），是官方建議做法，**勿移除**；私鑰／`.pem` 永不入庫。
- 本機 gh CLI 已安裝並以 Hank076 登入，可直接操作 release／runs。
- 發版 SOP：bump `manifests/manifest-chrome.json` version → commit → `git tag -a vX.Y.Z -m "notes"` → push tag，其餘自動。CWS 送審材料在 `docs/store/listing*.md`（docs/ 不入版控）。
- **發版流程勿寫進公開 README**（使用者 2026-07-11 決定：不對外公開 Releases 操作方式；曾 commit 後以 force push 撤下）。此流程只記在本檔與 docs/Handover.md。

## Architecture / Conventions

- **Stack**（2026-07-12 現代化後）: Vue 3.5 + TypeScript 5.9 + Pinia 4（2026-07-17 自 Vuex 4 遷移，vuex 已移除；因 Pinia 4 為 ESM-only，tsconfig `moduleResolution` 已改 `bundler`）+ Webpack 5.108（webpack-cli 7）+ Sass（@use）；ESLint 10 flat config（`eslint.config.mjs`，舊 .eslintrc 已除）+ prettier 3；測試 mocha 11 + sinon 22（瀏覽器內跑）。QR 解碼只用 `@zxing/library`（共用葉模組 `src/qr-decoder.ts`；jsqr 已於 2026-07-15 移除——無維護逾 5 年且 version 23 alignment 表誤植 74/78）。解碼於 **background** 執行（2026-07-16 遷移 b1a32fb）：content 隨 getCapture 送選區座標＋windowInnerWidth（該 sendMessage 帶 `.catch`→alert `capture_failed`，SW 不可達不再死寂，9bb944d），background 以 createImageBitmap＋OffscreenCanvas 切區（純函式 `computeQrCropRegion`，utils.test.ts 有測試）後解碼、直入 getTotp；解碼失敗發 `errorqr`，解出非 otpauth 內容發 i18n key `error_not_otpauth`（fc046f1，沿用既有 "text" alert 通道，content 零改動）。content.js 由 ~1.9MiB 回落 ~55KiB，background.js 增至 ~3.1MiB（SW 冷啟成本＝候選技術債：classic SW 可用 importScripts 拆 zxing chunk、擴充自讀免 WAR；Firefox MV3 event page 無 importScripts 需另案）。⚠ MV3 SW 內 `fetch(data:)` 被擴充 CSP connect-src 擋（Failed to fetch），dataURL→Blob 必須走 atob（`background.ts` 的 `dataUrlToBlob`），勿改回 fetch。（舊記載「getTotp message handler 死碼」已失效：2026-07-27 查證，message 分支鏈已無 getTotp case，`getTotp` 函式本身由 `decodeCapture` 直接呼叫，是活碼。）
- **版本鎖定紅線**（升級前必讀）：chai 鎖 4.x（v5+ ESM-only，與 CJS 建置不相容）；sinon-chai 鎖 3.7.0（4.x peer 要 chai≥5）；sinon-chrome 鎖 3.0.1（已死無替代）；TypeScript 禁升 6/7（Vue SFC 工具鏈相容未確認）；puppeteer 鎖 24.x（v25+ ESM-only 與 CJS test-runner 不相容；24.43.1 為 v24 末版，已無後續 patch）。（vuedraggable 紅線已除：2026-07-17 換成 vue-draggable-plus。）
- **加密**: Web Crypto（AES-GCM 寫入、SHA-256 金鑰衍生）＋ @noble/hashes（同步 HMAC 產碼、EVP 用 MD5）＋ argon2-browser ＋ node-gost-crypto。涉及金鑰與密文的程式碼屬安全邊界，不可便宜行事。**crypto-js 已於 2026-07-17 徹底移除**（feature/remove-crypto-js，計畫見 docs/plans/crypto-js-migration-plan.md）。⚠ 紅線：`src/models/legacy-decrypt.ts` 是舊密文（OpenSSL Salted__/EVP 格式）的相容性邊界——升級用戶既有資料與舊備份匯入靠它，**勿刪勿改語意**；其中 `legacyDecryptToHex` 對應 crypto-js `WordArray.toString()` 的 Hex 預設輸出（v2 金鑰路徑），改成 UTF-8 會造成既有使用者資料解不開。`src/test/utils.test.ts` 內的 legacy fixtures 與 RFC 4226/6238 vectors 是互解基準，勿刪。OTP 產碼 HMAC 呼叫鏈必須保持**同步**（otp.ts 註解明令），只能用同步庫（@noble/hashes），不可改 crypto.subtle。
- **樣式**: 顏色/間距一律使用 `sass/_tokens.scss` 的 design tokens / CSS custom properties，勿硬寫色碼。
- **i18n**: 新文案先加到 `_locales/en/messages.json`（key 來源）；Crowdin 已停用，各語系為手動翻譯維護（可直接編修）。所有語系 key 集須與 en 完全一致，由 `scripts/check-i18n.js`（CI `i18n` workflow，push/PR 觸發）強制。
- 行尾以 git `core.autocrlf=true` 管理，但 `.gitattributes` 未設 `* text=auto`，故 Windows 下偶有 EOL churn（檔案顯示 modified 但 `git diff` 為空）。Commit 前先 `git diff --stat` 確認沒有把 EOL-only 變更混進去。

## Known Quirks（recurring bugs，動前必讀）

1. **OTP enum 以「名稱」儲存**：OTP type / algorithm 在 storage 中存的是 enum 的**名稱字串**，不是數字。對它做 `parseInt` 是反覆出現的 bug（對應 upstream #1292 / #405 / #1442 / #1184）。
2. **accounts store 的 encryption 是 Map**：`useAccountsStore().encryption` 是 `Map`（Vuex 時代同）。用 bracket access（`encryption[key]`）會回傳 `undefined`，導致 secret 以**明文**存入。必須用 `.get()`（此 bug 已在 `AddAccountPage` 修過）。
3. **@vue/test-utils v2 migration**：`isVisible()` 依賴 `getComputedStyle`，需 `mount(..., { attachTo: document.body })` 才正確；測試環境中 `chrome.i18n.getMessage` 回傳空字串 `""`。
4. **`www.google.com` 權限是校時（syncTime），不是 Google Drive**：manifest 的 `www.google.com` host 權限與 CSP `connect-src` 供 clock-sync（抓 `Date` 標頭校正 TOTP 漂移）用。修剪 Google 相關權限時**勿誤刪**。
5. **build 產物目錄是 `js/` 非 `dist/`**（webpack output，commit f43f6cf）：bundle 在 `chrome/js/background.js`，manifest `service_worker` 指向 `js/background.js`。
6. **`UserSettings.removeItem` 是 read-modify-write**（`settings.ts:117`）：讀整份設定 blob→刪一個 key→寫回整份。多次未 await 的 removeItem 會交錯——各讀同一份快照、後寫者回滾前者的刪除（2026-07 Dropbox 登出曾因此殘留 refresh token）。要刪多個 key：`updateItems()`→delete 多個欄位→**單次** `commitItems()`。
7. **截圖腳本需保留 `en` _locales**：`src/store/i18n.ts` 永遠 `fetch("/_locales/en/messages.json")`；刪掉 en 語系會讓 popup mount 失敗（畫面空白）。`scripts/capture-store-screenshots.js` 靠「只留目標 + `en` _locales + 設 `default_locale`」強制截圖語系。
8. **智慧過濾預設開啟**：`smartFilter` 未設定時視為 `true`，明確儲存 `false` 時維持關閉；設定頁與帳戶清單共用 `useMenuStore().smartFilter` 的有效狀態。

## Testing / Build Gotchas（動工前必讀）

- **不要新增 `src/test/*.test.ts` 檔案**：會讓瀏覽器內 mocha 載入失敗（`window.__mocha_test_results__` undefined，test-runner 報 `Cannot read properties of undefined (reading 'completed')`），即使檔案內容極簡。**解法：把新測試併入既有測試檔（如 `src/test/utils.test.ts`），不要新增 `.test.ts` 檔。** 機制與 webpack `require.context` + 載入順序有關，未根治。
- `src/models/storage.ts` 與 `src/models/otp.ts` 互相 import（circular），測試載入順序敏感；葉節點模組（如 `src/utils.ts`，無 src model import）放共用純函式最安全。
- **build.sh 的 test-runner tsc 呼叫**（`--target ES2015 ... --moduleResolution nodenext --module nodenext --skipLibCheck scripts/test-runner.ts`）兩個旗標都不可動：`--module` 改回 commonjs 會觸發 TS 5.9 的 TS5110；`--skipLibCheck` 移除會因 @types/sinon-chrome 與 @types/chrome 0.2.x 型別不相容而炸（與 TS 版本無關；sinon-chrome 被替換後才可移除）。
- **webpack 的 `.wasm` rule 必須維持「裸 base64」**：`type: "asset/inline"` ＋ `generator.dataUrl = content => content.toString("base64")`，且**不可**恢復 `module.noParse: /\.wasm$/`——argon2-browser 拿匯出值直接 `atob()`，換成預設 data URI 或讓 noParse 讓 rule 失效，主密碼解鎖就壞（症狀在執行期，建置照樣綠燈）。
- **webpack.dev.js 的 `NormalModuleReplacementPlugin(/^node:/)` 與 `events` fallback 是 mocha 11 的硬需求**（mocha 11 內部用 `require("node:fs")`，webpack 5 在 fallback 之前就報 `UnhandledSchemeError`），勿當成冗餘設定清掉。
- **`src/definitions/vue.d.ts` 檔尾的 `export {}` 不可刪**：少了它整個檔退化為 script，`declare module "@vue/runtime-core"` 從「擴充」變成「陰影宣告」，全專案炸 `vue has no exported member ref/computed/...`——症狀酷似環境損壞，實為單行回歸（2026-07-17 Pinia 遷移移除 vuex import 時踩過）。
- 行尾以 git `core.autocrlf=true` 管理，但 `.gitattributes` 未設 `* text=auto`，故 Windows 下偶有 EOL churn（檔案顯示 modified 但 `git diff` 為空）。Commit 前先 `git diff --stat` 確認沒有把 EOL-only 變更混進去；勿 normalize 全 repo 行尾。
- **`npm run <target>` 各 target 互清產物**：跑 `firefox` 會把 `chrome/` 目錄刪掉（反之亦然）。要部署 chrome unpacked 測試版，最後一個 build 必須是 `npm run chrome`（驗收流程「chrome→firefox 都跑」之後 chrome/ 已不在，2026-07-16 踩過兩次）。
- **Dropbox 鎖不只咬 build**：`git add` 寫 `.git/objects` 也會間歇 `Permission denied`（實錄 2026-07-16：44 個 _locales 檔 add 失敗、commit 漏檔後 amend 補齊）。add/commit 失敗先重試，commit 後一律 `git show --stat` 核對檔數。
- **EOL stat-dirty 會擋 merge**：EOL churn 檔（diff 為空）有時仍被 merge 以「local changes would be overwritten」拒絕（stat/size 差異）。解法＝`git update-index --refresh` 讓 git 重新 hash 後自行放行（實錄 2026-07-16 ff merge dev）；**勿**用 `git checkout --` 批次丟棄來解。

## Security / Constraints

- 這是處理 OTP secret 與主密碼的安全敏感專案。加密、金鑰衍生、備份上傳路徑的修改務必謹慎，勿移除驗證或便宜化加密。
- **改 `src/argon.ts` 加密參數前必看**：金鑰鏈為 `saltedHash = argon2(密碼, salt, 參數)` → 金鑰 = `SHA256(saltedHash)`，解鎖時用當前硬編碼參數重算須等於設定時的值。**直接改 time/mem 會讓既有設密碼使用者永久無法解密既有 secret（不是重設密碼，是資料解不開）。** 要提高參數必須向後相容：從 `key.hash` 的 argon2 encoded string（`$m=,t=,p=$`）讀回原參數，只對新設定的密碼套用新參數。
- 雲端備份需先設定主密碼（master password）才可上傳（`cloudBackupAllowed` gate）。
- **雲端 OAuth 架構（2026-07 定案，勿走回頭路）**：只有 **Dropbox**（`chrome.identity.launchWebAuthFlow` + Authorization Code + **PKCE**，token 交換與 refresh 皆不帶 client_secret；擴充內零機密 secret）。**Google Drive in-client OAuth 已移除**——`chrome.identity.getAuthToken` 被 Google 2023-10 的 custom-URI-scheme 限制封殺（回 `Custom URI scheme is not supported on Chrome apps`），且 Google token endpoint 即使帶 PKCE 仍強制 secret、Desktop client 無法登記 `chromiumapp.org` redirect，故「Google + 免後端 + 零 secret」不可能。**勿再嘗試 getAuthToken**；Google 若要復活只能後端 token broker。擴充 Item ID=`compmlfocdmifebgiecbajaidkmgkonc`（OAuth redirect 用 `https://<id>.chromiumapp.org/`）。
- 備份匯出語意（2026-07 修正後）：`backupGetExport(encryption, encrypted)`——`encrypted=true` 保留 EncOTPStorage 密文＋附 keys（還原走 `decryptBackupData` 的 passphrase 流程）；`encrypted=false` 必須解密成明文並移除 `keyId`/`dataType`（`EntryStorage.import` 只收明文 entry）。修改備份/還原路徑時勿破壞此對稱。
- autofill 需 host 比對通過才注入驗證碼（host-bound autofill）。
- 架構隔離（2026-06 審查確認合格）：無 `externally_connectable`、無 `web_accessible_resources`、`background.ts` 驗證 `sender.id`、Argon2id+AES-GCM 加密。修改 manifest 權限或 message 邊界時勿破壞此隔離。
