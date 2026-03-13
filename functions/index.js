"use strict";

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();

const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const MAIL_REGION = "asia-east1";

function normalizeRecipients(rawTo) {
  if (Array.isArray(rawTo)) {
    return rawTo.map((v) => String(v || "").trim()).filter(Boolean);
  }
  if (typeof rawTo === "string") {
    const single = rawTo.trim();
    return single ? [single] : [];
  }
  return [];
}

async function collectDocsByUserKeys(db, collectionName, userKeys) {
  const deduped = new Map();
  for (const key of userKeys) {
    if (!key) continue;
    const snapshot = await db.collection(collectionName).where("userId", "==", key).get();
    snapshot.forEach((docSnap) => {
      deduped.set(docSnap.ref.path, docSnap.ref);
    });
  }
  return Array.from(deduped.values());
}

async function collectDocsByField(db, collectionName, fieldName, fieldValue) {
  const deduped = new Map();
  const snapshot = await db.collection(collectionName).where(fieldName, "==", fieldValue).get();
  snapshot.forEach((docSnap) => {
    deduped.set(docSnap.ref.path, docSnap.ref);
  });
  return Array.from(deduped.values());
}

async function batchDeleteDocs(docRefs) {
  const db = admin.firestore();
  const chunkSize = 400;
  for (let i = 0; i < docRefs.length; i += chunkSize) {
    const chunk = docRefs.slice(i, i + chunkSize);
    const batch = db.batch();
    chunk.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

async function resolveAdminRole(db, callerUid, callerEmail) {
  const allowedRoles = new Set(["admin", "super_admin"]);

  const callerDoc = await db.collection("users").doc(callerUid).get();
  if (callerDoc.exists && allowedRoles.has(String(callerDoc.data()?.role || "").toLowerCase())) {
    return true;
  }

  const callerByUid = await db.collection("users").where("uid", "==", callerUid).limit(1).get();
  if (!callerByUid.empty && allowedRoles.has(String(callerByUid.docs[0].data()?.role || "").toLowerCase())) {
    return true;
  }

  if (callerEmail) {
    const callerByEmail = await db.collection("users").where("email", "==", callerEmail).limit(1).get();
    if (!callerByEmail.empty && allowedRoles.has(String(callerByEmail.docs[0].data()?.role || "").toLowerCase())) {
      return true;
    }
  }

  return false;
}

exports.sendEmailNotification = onDocumentCreated(
  {
    document: "emailNotifications/{docId}",
    region: MAIL_REGION,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn("No snapshot data in event");
      return;
    }

    const db = admin.firestore();
    const data = snap.data() || {};
    const to = normalizeRecipients(data.to);
    const message = data.message || {};
    const subject = String(message.subject || "").trim();
    const text = String(message.text || "").trim();
    const html = String(message.html || "").trim();

    if (!to.length || !subject || (!text && !html)) {
      logger.error("Invalid email payload", { docId: snap.id, to, subject });
      await snap.ref.set(
        {
          status: "failed",
          error: "Invalid payload: require to/subject/text-or-html",
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return;
    }

    const user = GMAIL_USER.value();
    const pass = GMAIL_APP_PASSWORD.value();

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass },
    });

    const from = `體重管理班通知 <${user}>`;
    const mailOptions = {
      from,
      to: to.join(","),
      subject,
      text: text || undefined,
      html: html || undefined,
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      logger.info("Email sent", { docId: snap.id, messageId: info.messageId, toCount: to.length });
      await snap.ref.set(
        {
          status: "sent",
          provider: "gmail-smtp",
          messageId: info.messageId || "",
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      logger.error("Email send failed", {
        docId: snap.id,
        message: error && error.message ? error.message : String(error),
      });
      await snap.ref.set(
        {
          status: "failed",
          provider: "gmail-smtp",
          error: error && error.message ? error.message : String(error),
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    await db.collection("emailNotificationLogs").add({
      sourceDocId: snap.id,
      to,
      subject,
      source: String(data.source || ""),
      status: "processed",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);

exports.deleteStudentAccountData = onCall(
  { region: MAIL_REGION, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "需要先登入管理員帳號");
    }

    const callerUid = request.auth.uid;
    const callerEmail = String(request.auth.token?.email || "").trim().toLowerCase();
    const db = admin.firestore();
    const isAdmin = await resolveAdminRole(db, callerUid, callerEmail);

    if (!isAdmin) {
      throw new HttpsError("permission-denied", "僅管理員可執行此操作");
    }

    const payload = request.data || {};
    const targetUid = String(payload.uid || "").trim();
    const targetUsername = String(payload.username || "").trim().toLowerCase();
    const targetEmail = String(payload.email || "").trim().toLowerCase();
    const targetEmailPrefix = targetEmail.includes("@") ? targetEmail.split("@")[0] : "";

    if (!targetUid && !targetUsername && !targetEmailPrefix) {
      throw new HttpsError("invalid-argument", "缺少學員識別資料");
    }

    let resolvedUid = targetUid;
    if (!resolvedUid && targetUsername) {
      const userByUsername = await db.collection("users").where("username", "==", targetUsername).limit(1).get();
      if (!userByUsername.empty) {
        resolvedUid = userByUsername.docs[0].id;
      }
    }

    if (!resolvedUid && targetEmail) {
      const userByEmail = await db.collection("users").where("email", "==", targetEmail).limit(1).get();
      if (!userByEmail.empty) {
        resolvedUid = userByEmail.docs[0].id;
      }
    }

    const userKeys = Array.from(
      new Set([resolvedUid, targetUid, targetUsername, targetEmailPrefix].filter(Boolean).map((v) => String(v).toLowerCase()))
    );

    const collectionsToDelete = ["客戶資料", "每日體重三圍", "飲食份數表", "原始體重三圍", "中醫體質四象限", "減肥歷史"];
    let refsToDelete = [];
    for (const name of collectionsToDelete) {
      const refs = await collectDocsByUserKeys(db, name, userKeys);
      refsToDelete = refsToDelete.concat(refs);
    }

    if (resolvedUid) {
      refsToDelete.push(db.collection("users").doc(resolvedUid));
    }

    const dedupRefs = Array.from(new Map(refsToDelete.map((r) => [r.path, r])).values());
    await batchDeleteDocs(dedupRefs);

    if (resolvedUid) {
      try {
        await admin.auth().deleteUser(resolvedUid);
      } catch (error) {
        if (error?.code !== "auth/user-not-found") {
          logger.error("Delete auth user failed", { uid: resolvedUid, message: error?.message || String(error) });
          throw new HttpsError("internal", "刪除 Auth 帳號失敗");
        }
      }
    }

    return {
      success: true,
      deletedDocs: dedupRefs.length,
      deletedAuthUid: resolvedUid || ""
    };
  }
);

exports.deleteClassAccountData = onCall(
  { region: MAIL_REGION, timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "需要先登入管理員帳號");
    }

    const callerUid = request.auth.uid;
    const callerEmail = String(request.auth.token?.email || "").trim().toLowerCase();
    const db = admin.firestore();
    const isAdmin = await resolveAdminRole(db, callerUid, callerEmail);

    if (!isAdmin) {
      throw new HttpsError("permission-denied", "僅管理員可執行此操作");
    }

    const payload = request.data || {};
    const classId = String(payload.classId || "").trim();
    if (!classId) {
      throw new HttpsError("invalid-argument", "缺少班級識別資料");
    }

    const classRef = db.collection("classes").doc(classId);
    const classSnap = await classRef.get();
    if (!classSnap.exists) {
      throw new HttpsError("not-found", "找不到指定班級");
    }

    const usersSnapshot = await db.collection("users").where("primaryClassId", "==", classId).get();
    const classUsers = usersSnapshot.docs
      .map((docSnap) => ({ ref: docSnap.ref, uid: docSnap.id, ...docSnap.data() }))
      .filter((row) => {
        const role = String(row.role || "").toLowerCase();
        return role === "student" || role === "customer" || role === "coach";
      });

    const collectionsToDeleteByUser = [
      "客戶資料",
      "每日體重三圍",
      "飲食份數表",
      "原始體重三圍",
      "中醫體質四象限",
      "減肥歷史",
      "3日飲食記錄",
    ];

    const collectionsToDeleteByClass = [
      "客戶資料",
      "每日體重三圍",
      "飲食份數表",
      "原始體重三圍",
      "中醫體質四象限",
      "減肥歷史",
      "3日飲食記錄",
    ];

    let refsToDelete = [classRef];
    const authUidsToDelete = [];

    for (const userRow of classUsers) {
      const targetUid = String(userRow.uid || "").trim();
      const targetUsername = String(userRow.username || "").trim().toLowerCase();
      const targetEmail = String(userRow.email || "").trim().toLowerCase();
      const targetEmailPrefix = targetEmail.includes("@") ? targetEmail.split("@")[0] : "";
      const userKeys = Array.from(
        new Set([targetUid, targetUsername, targetEmailPrefix].filter(Boolean).map((v) => String(v).toLowerCase()))
      );

      for (const name of collectionsToDeleteByUser) {
        const refs = await collectDocsByUserKeys(db, name, userKeys);
        refsToDelete = refsToDelete.concat(refs);
      }

      refsToDelete.push(userRow.ref);
      if (targetUid) {
        authUidsToDelete.push(targetUid);
      }
    }

    for (const name of collectionsToDeleteByClass) {
      const refs = await collectDocsByField(db, name, "classId", classId);
      refsToDelete = refsToDelete.concat(refs);
    }

    const dedupRefs = Array.from(new Map(refsToDelete.map((r) => [r.path, r])).values());
    await batchDeleteDocs(dedupRefs);

    for (const uid of Array.from(new Set(authUidsToDelete))) {
      try {
        await admin.auth().deleteUser(uid);
      } catch (error) {
        if (error?.code !== "auth/user-not-found") {
          logger.error("Delete class auth user failed", { uid, message: error?.message || String(error) });
          throw new HttpsError("internal", "刪除班級成員 Auth 帳號失敗");
        }
      }
    }

    return {
      success: true,
      classId,
      deletedDocs: dedupRefs.length,
      deletedAuthUsers: Array.from(new Set(authUidsToDelete)).length,
    };
  }
);
