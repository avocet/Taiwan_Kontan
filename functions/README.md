# Firebase Cloud Functions Email Notifications

本專案使用 Firestore 集合 `emailNotifications` 作為寄信佇列。

## 1) 安裝依賴

```bash
cd functions
npm install
```

## 2) 設定 Gmail SMTP 秘密參數

請先在 Gmail 帳號開啟兩步驟驗證，並建立「應用程式密碼」。

```bash
firebase functions:secrets:set GMAIL_USER
firebase functions:secrets:set GMAIL_APP_PASSWORD
```

輸入值：
- `GMAIL_USER`: 你的 Gmail 帳號（例如 `yourname@gmail.com`）
- `GMAIL_APP_PASSWORD`: Gmail 應用程式密碼（16碼）

## 3) 部署 Functions

```bash
firebase deploy --only functions
```

## 4) 測試

前端送出聊天室訊息後，會寫入 `emailNotifications` 文件，Function 會自動寄信並回寫：
- `status: sent` 或 `failed`
- `processedAt`
- `messageId` / `error`
