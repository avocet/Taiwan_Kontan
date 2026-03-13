# 商品化部署說明

這份專案目前已整理成可對應：

- `阿克索公司`
- `減重班`
- `管理員 / 班主任 / 學員`

若要交付給不同客戶自己的 Firebase 專案，建議照下面流程部署。

## 1. 建立客戶自己的 Firebase 專案

客戶端需要自行建立：

- Firebase Project
- Authentication
- Firestore Database
- Storage
- Functions
- Hosting

建議每個客戶一個獨立 project，不要共用。

## 2. 複製專案並填入 Firebase 專案資訊

本專案附了兩個模板：

- [.firebaserc.example](/Users/wangyuanyong/Library/Mobile%20Documents/com~apple~CloudDocs/TWKT/.firebaserc.example)
- [firebase.web.config.template.js](/Users/wangyuanyong/Library/Mobile%20Documents/com~apple~CloudDocs/TWKT/firebase.web.config.template.js)

也可以直接使用腳本：

```bash
./scripts/setup-customer-project.sh <project_id> <api_key> <auth_domain> <storage_bucket> <messaging_sender_id> <app_id> <measurement_id>
```

這會自動建立：

- `.firebaserc`
- `firebase.web.config.js`

## 3. 安裝 Functions 依賴

```bash
cd functions
npm install
cd ..
```

## 4. 設定寄信用 Secrets

```bash
firebase functions:secrets:set GMAIL_USER
firebase functions:secrets:set GMAIL_APP_PASSWORD
```

每個客戶建議用自己的 Gmail 或 SMTP 帳號，不要共用同一組寄信帳號。

## 5. 部署

```bash
firebase deploy
```

目前 [firebase.json](/Users/wangyuanyong/Library/Mobile%20Documents/com~apple~CloudDocs/TWKT/firebase.json) 已包含：

- `functions`
- `hosting`

## 6. 首次啟用後的管理設定

進入系統後，管理員首頁已可：

- 建立減重班
- 新增學員
- 調整學員班級
- 補齊舊資料的 `companyId / classId / classIds`

建議第一次部署完成後：

1. 先登入管理員帳號
2. 建立正式班級
3. 指派班主任與學員
4. 執行一次「資料補齊」

## 7. 建議的商品化交付內容

如果要包成可販售方案，建議交付這些內容：

- 網站前端檔案
- Cloud Functions
- Firebase Hosting 設定
- `.firebaserc.example`
- 初始化腳本
- 安裝手冊
- Secrets 設定說明

## 8. 目前還沒完全模板化的部分

目前專案仍有多個 HTML 頁面內寫死同一組 `firebaseConfig`。

這代表：

- 已可作為多客戶部署模板使用
- 但如果要做到完全商品化的一鍵安裝版，下一步建議把所有頁面改成統一讀取 `firebase.web.config.js`

這樣每個客戶只需要換一份 config，不必改每個頁面。
