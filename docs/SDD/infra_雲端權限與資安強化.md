---
module: infra
功能: 雲端權限與資安強化
狀態: 已實作
更新日期: 2026-09-04
---

# infra — 雲端權限與資安強化

## 目的

擴充套件只啟用 Dropbox 雲端備份。Google Drive 與 OneDrive 保留相容程式碼及非敏感設定，但不得執行 OAuth、上傳或排程備份。Dropbox OAuth 使用 request-bound state，manifest 檢查阻止停用服務權限回歸。

## 使用情境

- 使用者只會看到 Dropbox 與校時需要的雲端權限。
- Dropbox callback 必須屬於同一次授權請求。
- 舊版本的 Drive、OneDrive token 會被移除，偏好會保留。
- 維護者修改 manifest 時，CI 拒絕 Google Drive、OneDrive 的 OAuth 或 network origin。

## 輸入與輸出

| 輸入 | 型別 | 說明 |
| --- | --- | --- |
| provider ID | `string` | 雲端服務識別值 |
| OAuth callback URL | `string` | Dropbox callback 的 code 與 state |
| manifest | JSON | 各 target 權限來源 |

| 輸出 | 型別 | 說明 |
| --- | --- | --- |
| provider 可用狀態 | `boolean` | 只有 Dropbox 為 `true` |
| OAuth 結果 | token 或失敗 | state 不符時不交換或儲存 token |
| manifest 檢查結果 | exit code | 違規時為非 `0` |

## 資料模型

`src/cloud-providers.ts` 定義無持久化的 provider 狀態、16 個隨機位元組的 Dropbox state 及其比對函式。state 與 PKCE verifier 只存在單次授權流程的記憶體閉包。

| provider | 啟用 | 清除欄位 | 保留欄位 |
| --- | --- | --- | --- |
| Dropbox | 是 | 無 | 全部 |
| Google Drive | 否 | `driveToken`、`driveRefreshToken` | `driveEncrypted`、`driveFolder`、`driveRevoked` |
| OneDrive | 否 | `oneDriveToken`、`oneDriveRefreshToken` | `oneDriveBusiness`、`oneDriveEncrypted`、`oneDriveRevoked` |

Backup store 在同一份 `UserSettings.items` 刪除所有停用 provider token，且只呼叫一次 `commitItems()`。

## 處理流程

1. Backup store 讀取 settings，移除停用 provider 的 token；有變動才單次寫入。
2. Drive 與 OneDrive 的 Pinia token state 固定為未連線。
3. background 與 upload 入口先通過 provider gate；停用 provider 立即返回。
4. Dropbox 授權產生 PKCE 及 state，將 state 加入 authorization URL。
5. callback 缺少 code、state 或 state 不符時，不交換 token 並送出 `dropboxauthdone`。
6. token endpoint 只在 HTTP 成功且含 access token 時寫入 token。
7. 排程只處理 Dropbox；OneDrive `upload()` 也自行拒絕。
8. CI 執行 manifest 檢查，拒絕 Google Drive、OneDrive OAuth、origin 與 CSP connect-src。

## 錯誤處理

| 情況 | 行為 | 使用者看到什麼 |
| --- | --- | --- |
| 停用 provider action | provider gate 返回 | 不開啟 OAuth 視窗 |
| state 缺少或不符 | 不交換 token，送出完成訊息 | 登入結束，未儲存 token |
| token endpoint 非 2xx | 不儲存 token，記錄不含憑證的錯誤 | 登入結束 |
| manifest 含禁用 origin | 腳本顯示檔案、欄位與 origin 後失敗 | CI 失敗 |

## 相依項目

- `chrome.identity`：Dropbox Authorization Code + PKCE。
- `chrome.permissions`：Dropbox 與 `src/syncTime.ts` 校時權限。
- `UserSettings`：Dropbox token 與停用 provider token 清除。
- GitHub Actions：manifest 回歸檢查。
- Production dependency audit 為 0 vulnerabilities。完整 audit 保留 8 個 build/test-only 弱點；其中 Mocha 與 Puppeteer 的修正需要跨越專案版本紅線。

## 實作位置

| 檔案 | 職責 |
| --- | --- |
| `src/cloud-providers.ts` | provider gate、Dropbox state 純函式 |
| `src/background.ts` | message、OAuth 與 upload gate |
| `src/models/backup.ts` | OneDrive upload 防禦性 gate |
| `src/popup.ts` | Dropbox 排程備份 |
| `src/store/Backup.ts` | token 清除與連線 state |
| `src/components/Popup/BackupPage.vue` | OneDrive unavailable UI |
| `manifests/manifest-chrome-testing.json` | Chrome testing 權限邊界 |
| `manifests/manifest-edge.json` | Edge 權限邊界 |
| `manifests/manifest-firefox-testing.json` | Firefox testing 權限邊界 |
| `scripts/check-cloud-permissions.js` | manifest 檢查 |
| `src/test/utils.test.ts` | provider、OAuth state、token 清除測試 |
| `package.json` | 檢查指令 |
| `package-lock.json` | 相容範圍內的 transitive dependency 安全更新 |
| `.github/workflows/main.yml` | CI 檢查 |
