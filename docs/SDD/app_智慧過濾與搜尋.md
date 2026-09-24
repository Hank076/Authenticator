---
module: app
功能: 智慧過濾與搜尋
狀態: 已實作
更新日期: 2026-09-24
---

# app — 智慧過濾與搜尋

## 目的

讓使用者在 popup 中優先辨識與目前網站相關的 OTP 帳戶，並以文字搜尋帳戶。智慧過濾預設開啟；使用者明確關閉後保留其選擇。

## 使用情境

- 使用者首次開啟擴充套件時，預設啟用智慧過濾。
- 使用者在設定中關閉智慧過濾後，下次開啟仍維持關閉。
- 使用者輸入 issuer 或 account 文字時，清單隱藏不符合搜尋文字的帳戶。

## 輸入與輸出

### 輸入

| 項目 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| 目前分頁資訊 | `string[]` | 是 | 正規化 title、domain 名稱與 hostname。 |
| OTP 帳戶 | `OTPEntry[]` | 是 | 用於網站配對及文字搜尋的帳戶清單。 |
| 搜尋文字 | `string` | 否 | 與 issuer、account 進行不分大小寫的部分比對。 |
| `smartFilter` | `boolean` | 否 | 未設定時視為開啟；明確儲存 `false` 時關閉。 |

### 輸出

| 項目 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| 帳戶清單 | `OTPEntry[]` | 是 | 網站配對帳戶優先顯示；搜尋時隱藏文字不符的項目。 |
| 智慧過濾開關狀態 | `boolean` | 是 | 反映有效設定值。 |

## 資料模型

`UserSettings.items.smartFilter` 儲存使用者的明確選擇。搜尋文字只存在於 popup 元件狀態，不寫入儲存空間。

## 處理流程

1. 讀取設定；`smartFilter` 未設定時啟用智慧過濾，明確為 `false` 時關閉。
2. 以目前分頁資訊與帳戶資料計算網站配對結果。
3. 有網站配對結果時，清單優先顯示配對或釘選帳戶，其他帳戶顯示於次要區域。
4. 搜尋文字不為空時，依 issuer 或 account 隱藏不符合的帳戶。
5. 使用者切換智慧過濾設定時，儲存明確的布林值並更新清單。
6. autofill 僅使用嚴格 hostname 綁定，不採用 title 或 issuer 提示。

## 錯誤處理

| 情況 | 行為 | 使用者看到什麼 |
| --- | --- | --- |
| 無法取得目前分頁或沒有網站配對結果 | 不套用網站配對顯示 | 完整帳戶清單。 |
| 搜尋沒有結果 | 隱藏不符合的帳戶 | 清單沒有符合項目。 |

## 相依項目

- Chrome Tabs API：提供目前分頁的 title 與 URL。
- `UserSettings`：讀取與儲存智慧過濾選擇。
- Pinia Menu 與 Accounts stores：提供有效設定值和網站配對結果。
- Popup 樣式：隱藏不符合搜尋文字的帳戶。

## 實作位置

| 檔案 | 職責 |
| --- | --- |
| `src/store/Menu.ts` | 初始化智慧過濾預設值及儲存使用者選擇。 |
| `src/store/Accounts.ts` | 依有效設定值與配對結果決定是否啟用智慧過濾。 |
| `src/components/Popup/MainBody.vue` | 合併網站配對、搜尋與清單顯示狀態。 |
| `src/components/Popup/PreferencesPage.vue` | 顯示並切換智慧過濾設定。 |
| `src/models/settings.ts` | 保存 `smartFilter` 設定欄位。 |
| `src/utils.ts` | 執行網站配對與搜尋狀態判定。 |
| `sass/popup.scss` | 隱藏不符合搜尋文字的帳戶。 |
| `src/test/utils.test.ts` | 驗證網站配對與搜尋狀態判定。 |
