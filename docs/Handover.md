# 待辦與交接

更新日期：2026-09-24

## 重要且緊急

| 待辦 | 為什麼 | 從哪裡開始 |
| --- | --- | --- |
| 在 Chrome 載入本機 `chrome/` 並驗收智慧過濾與搜尋 | 使用者需確認預設開啟、手動關閉後保留設定及搜尋結果 | `chrome://extensions` 重新載入擴充套件，測試 `src/components/Popup/MainBody.vue` 對應畫面 |

## 重要不緊急

| 待辦 | 為什麼 | 從哪裡開始 |
| --- | --- | --- |
| 確認 UniFi 帳戶的智慧過濾配對方式 | `UniFi OS` 頁面標題與 `Unifi Ubiquiti SSO` issuer 未被現行比對規則配對 | 檢查 `src/utils.ts` 的 `isMatchedEntry`，確認使用品牌詞配對或手動綁定 host |

## 不重要但緊急

無

## 不重要不緊急

| 待辦 | 為什麼 | 從哪裡開始 |
| --- | --- | --- |
| 評估 background QR 解碼的冷啟成本 | background bundle 包含 QR 解碼函式庫 | 量測 `src/background.ts` 中解碼流程的啟動時間 |
| 補齊 fy 與 kaa 語系的 `error_not_otpauth` 翻譯 | 該訊息沿用英文 | 檢查 `_locales/fy/messages.json` 與 `_locales/kaa/messages.json` |
