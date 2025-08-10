
import { DateTime } from "luxon";
import nodemailer from "nodemailer";

export const config = { runtime: "nodejs", maxDuration: 60 };

function getBearerFromEnv() {
  const { PAYMARK_BEARER, PAYMARK_LS_JSON } = process.env;
  if (PAYMARK_BEARER && PAYMARK_BEARER.trim()) return PAYMARK_BEARER.trim();
  if (!PAYMARK_LS_JSON) return null;
  try {
    const obj = JSON.parse(PAYMARK_LS_JSON);
    const authRaw = obj.auth;
    if (!authRaw) return null;
    const auth = typeof authRaw === "string" ? JSON.parse(authRaw) : authRaw;
    const token = auth?.access_token || auth?.token || null;
    return token || null;
  } catch (e) {
    return null;
  }
}

function buildCsv(rows) {
  const headers = ["transactionDateTime","cardType","transactionType","amount","currency","authorisationCode","referenceNumber","maskedPan","result"];
  const out = [headers.join(",")];
  for (const r of rows) {
    const line = [
      r.transactionDateTime ?? r.time ?? "",
      r.cardType ?? "",
      r.transactionType ?? r.type ?? "",
      (r.amount ?? r.totalAmount ?? r.txnAmount ?? r.settlementAmount ?? "").toString().replaceAll(",", ""),
      r.currency ?? "NZD",
      r.authorisationCode ?? r.authCode ?? "",
      r.referenceNumber ?? r.reference ?? r.ref ?? "",
      r.maskedPan ?? r.cardNumberMasked ?? "",
      r.result ?? r.status ?? ""
    ].map(v => (v ?? "").toString().replaceAll(",", " ")).join(",");
    out.push(line);
  }
  return out.join("\n");
}

async function fetchTransactions(apiUrl, bearer) {
  const res = await fetch(apiUrl, {
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "NZ AutoTech Paymark Reporter/1.0"
    },
    cache: "no-store"
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, bodyText: text, json };
}

async function sendEmail({ subject, text, csv, ymd, mailEnv }) {
  const transporter = nodemailer.createTransport({
    host: mailEnv.SMTP_HOST,
    port: Number(mailEnv.SMTP_PORT || 587),
    secure: false,
    auth: { user: mailEnv.SMTP_USER, pass: mailEnv.SMTP_PASS }
  });
  const attachments = [
    { filename: `transactions_${ymd}.csv`, content: csv, contentType: "text/csv; charset=utf-8" }
  ];
  await transporter.sendMail({
    from: mailEnv.MAIL_FROM,
    to: mailEnv.MAIL_TO,
    subject,
    text,
    attachments
  });
}

export default async function handler(req, res) {
  try {
    const urlObj = new URL(req.url, "http://local");
    const debug = urlObj.searchParams.get("debug") === "1";
    const page = urlObj.searchParams.get("page") || "1";
    const limit = urlObj.searchParams.get("limit") || "100";

    const bearer = getBearerFromEnv();
    if (!bearer) {
      return res.status(500).json({ ok:false, error:"缺少令牌：请设置 PAYMARK_BEARER，或在 PAYMARK_LS_JSON 中包含 auth.access_token。" });
    }

    const nzNow = DateTime.now().setZone("Pacific/Auckland");
    const startNZ = nzNow.startOf("day");
    const endNZ   = nzNow.endOf("day");
    const timeFromUTC = startNZ.toUTC().toISO();
    const timeToUTC   = endNZ.toUTC().toISO();
    const ymd = nzNow.toFormat("yyyy-LL-dd");

    const cardAcceptorIdCodes = urlObj.searchParams.get("cardAcceptorIdCodes") || "10243212";
    const base = "https://api.paymark.nz/merchant/transaction/";
    const apiUrl = new URL(base);
    apiUrl.searchParams.set("cardAcceptorIdCodes", cardAcceptorIdCodes);
    apiUrl.searchParams.set("transactionTimeFrom", urlObj.searchParams.get("from") || timeFromUTC);
    apiUrl.searchParams.set("transactionTimeTo", urlObj.searchParams.get("to") || timeToUTC);
    apiUrl.searchParams.set("page", page);
    apiUrl.searchParams.set("limit", limit);

    const { status, ok, json, bodyText } = await fetchTransactions(apiUrl.toString(), bearer);
    if (!ok) {
      return res.status(500).json({ ok:false, status, sample: bodyText.slice(0,300), api: apiUrl.toString() });
    }

    let rows = [];
    if (Array.isArray(json)) rows = json;
    else if (Array.isArray(json?.data)) rows = json.data;
    else if (Array.isArray(json?.items)) rows = json.items;
    else if (Array.isArray(json?.results)) rows = json.results;
    else if (json?.content && Array.isArray(json.content)) rows = json.content;

    if (debug) {
      return res.status(200).json({ ok:true, count: rows.length, status, used:"bearer", api: apiUrl.toString(), sample: rows[0] ?? null });
    }

    const csv = buildCsv(rows);
    const mailEnv = {
      MAIL_TO: process.env.MAIL_TO,
      MAIL_FROM: process.env.MAIL_FROM,
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS
    };
    for (const k of Object.keys(mailEnv)) {
      if (!mailEnv[k]) return res.status(500).json({ ok:false, error:`缺少邮件环境变量: ${k}` });
    }

    await sendEmail({
      subject: `Paymark Transactions — ${ymd} (NZ)`,
      text: `Attached are today's transactions (${ymd} NZ). Count: ${rows.length}.`,
      csv,
      ymd,
      mailEnv
    });
    res.status(200).json({ ok:true, sent:true, count: rows.length, dateNZ: ymd });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
}
