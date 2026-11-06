# 月供投資：Firebase 設定與安全說明

投資頁是獨立頁面 `/invest/`，不再嵌在主站裡。在完成下面設定前，它以**本機測試模式**運作：沒有登入、資料只存在目前瀏覽器。

## 1. 建立專案
1. 打開 https://console.firebase.google.com ，新增專案（可關閉 Google Analytics）。
2. 專案總覽 -> 點 `</>`（Web）-> 註冊應用程式（不要勾 Hosting）。
3. 複製 `firebaseConfig`，把 `apiKey / authDomain / projectId / appId` 填進 `invest/firebase-config.js`。這些值本來就是公開的，不是密碼。

## 2. 登入設定（重要）
1. Authentication -> Sign-in method -> 只啟用「電子郵件/密碼」。**關閉**「允許使用者自行註冊」（Settings -> User actions -> 取消勾選 Enable create (sign-up)）。
2. Users 分頁 -> 手動新增你自己的使用者，用強密碼（建議 16 字元以上，密碼管理器產生）。
3. 複製該使用者的 UID。
4. Settings -> Authorized domains：只保留 `areruyahaptism.github.io`（和 localhost 測試用，用完可刪）。

## 3. 資料庫與規則
1. Firestore Database -> 建立資料庫（正式版模式）。
2. 規則分頁貼上 `invest/firestore.rules`，**把兩處以上的 `YOUR_OWN_UID` 全換成你的 UID**，發布。
   這是真正的防線：就算有人拿公開的 apiKey 自己註冊，也讀不到、寫不進你的資料。規則也限制了欄位和金額範圍。

## 4. API 金鑰安全（Google Cloud Console）
Firebase 的 apiKey 是公開的，要在 Google Cloud Console -> APIs & Services -> Credentials 對它加限制：
- **Application restrictions**：HTTP referrers，只填 `https://areruyahaptism.github.io/*`
- **API restrictions**：只勾 Identity Toolkit API、Token Service API、Cloud Firestore API

## 5. 行情 API（選用）
Twelve Data 免費帳號即可。到「設定」頁填金鑰，金鑰只存在你的私有 Firestore。不填就手動輸入價格，所有功能照常。

## 6. 發布前必做
- GitHub 帳號開啟 2FA（建議 passkey）。**能推程式碼的人就能改掉登入頁偷密碼，這是最大單點風險。**
- 倉庫的 main 分支開保護：禁止 force push。
- 不要把 `invest/tests.html` 推上去（已在 `.gitignore`，含真實餘額）。

## 現有的安全措施
| 項目 | 做法 |
|---|---|
| 登入 | Firebase Auth，無註冊入口，帳號只能在後台建立 |
| 登入狀態 | 只存在當前分頁（關閉分頁即登出），閒置 30 分鐘自動登出，連錯 5 次鎖 1 分鐘 |
| 資料權限 | Firestore 規則限定你的 UID，並檢查欄位與型別 |
| XSS 防護 | 獨立頁面 + 嚴格 CSP（只允許自己的腳本與樣式，無 inline、無 eval），所有輸出都做 HTML 轉義 |
| 供應鏈 | Firebase SDK 已下載到 `invest/vendor/` 自行託管，頁面不載入任何外部腳本 |
| 隔離 | 與六合彩工具分開頁面；防 iframe 嵌入 |
| 搜尋引擎 | noindex、no-referrer |

## 限制（請知悉）
- GitHub Pages 無法設定 HTTP 標頭，所以 CSP 用 `<meta>` 實作，`frame-ancestors` 不生效（已用腳本補防）。同網域的六合彩頁面仍與投資頁同源；兩者目前沒有共用資料，但如果六合彩頁被植入惡意腳本，理論上能讀取同源儲存。要徹底隔離，需要把投資頁搬到獨立網域（例如 Cloudflare Pages + 自訂網域），`invest/_headers` 已備好完整標頭。
- Firebase SDK 升級時需要手動重新下載到 `vendor/`（目前版本 11.0.2）。
- 前端安全無法抵擋你自己電腦中毒。

## 檔案
| 檔案 | 用途 |
|---|---|
| `index.html` / `boot.js` | 獨立頁面與啟動 |
| `engine.js` | 規則引擎（純函式）：資金池、Level、帳本統計、指引 |
| `app.js` | 登入、Firestore、介面 |
| `firestore.rules` | 資料庫權限規則 |
| `_headers` | 改用 Cloudflare/Netlify 時的完整安全標頭 |
| `vendor/` | 自行託管的 Firebase SDK |
| `tests.html` | 引擎測試（僅本機，不推送） |
