"use strict";

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
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
