
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
  } catch { return null; }
}

function formatNZDate(iso) {
  if (!iso) return "";
  try {
    const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone("Pacific/Auckland");
    return dt.toFormat("dd/LL/yyyy 'at' h:mm:ss a");
  } catch { return iso; }
}
function toMoney(n) { if (n == null) return 0; const num = Number(n); return Number.isFinite(num) ? num : 0; }
function toMoneyStr(n) { return toMoney(n).toFixed(2); }

function normalizeRows(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.transactions)) return json.transactions;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.results)) return json.results;
  if (json.content && Array.isArray(json.content)) return json.content;
  return [];
}

function buildCsvUI(rows) {
  const headers = ["Terminal ID","Transaction Date (NZ)","Settlement","Last 4","TXN #","Card","Type","Purchase","Cash","Status"];
  const out = [headers.join(",")];
  for (const r of rows) {
    const type = (Number(r.tranType) === 5 || (r.purchaseAmount ?? 0) > 0) ? "Purchase" : (r.tranType ?? "");
    const line = [
      r.terminalId ?? "",
      formatNZDate(r.transactionTime ?? r.transactionDateTime ?? ""),
      r.settlementDate ?? "",
      r.suffix ?? r.last4 ?? "",
      r.transactionNumber ?? r.txnNumber ?? "",
      r.cardLogo ?? r.cardType ?? "",
      type,
      toMoneyStr(r.purchaseAmount ?? r.transactionAmount ?? r.amount ?? 0),
      toMoneyStr(r.cashoutAmount ?? r.cashAmount ?? 0),
      r.status ?? r.result ?? ""
    ].map(v => (v ?? "").toString().replaceAll(",", " ")).join(",");
    out.push(line);
  }
  return out.join("\n");
}

function buildSvgSummary(rows, ymd) {
  const width = 900, height = 420, pad = 24;
  const bg = "#0B1220", fg = "#E6EDF3", sub = "#9DB1C7", acc = "#32D583";
  const total = rows.length;
  let purchase = 0, cashout = 0;
  const buckets = Array.from({length: 24}, () => 0);
  let lastMillis = 0;

  for (const r of rows) {
    purchase += toMoney(r.purchaseAmount ?? r.transactionAmount ?? r.amount ?? 0);
    cashout += toMoney(r.cashoutAmount ?? r.cashAmount ?? 0);
    const t = r.transactionTime ?? r.transactionDateTime;
    if (t) {
      const dt = DateTime.fromISO(t, {zone:'utc'}).setZone('Pacific/Auckland');
      buckets[dt.hour]++;
      lastMillis = Math.max(lastMillis, dt.toMillis());
    }
  }

  const lastNZ = lastMillis ? DateTime.fromMillis(lastMillis).toFormat("h:mm a") : "-";
  const maxBucket = Math.max(1, ...buckets);
  const chartW = width - pad*2, chartH = 160, chartY = 200, chartX = pad;
  const barW = chartW / 24.0 - 2;

  let bars = "";
  for (let h=0; h<24; h++) {
    const val = buckets[h];
    const bh = Math.round((val / maxBucket) * chartH);
    const x = Math.round(chartX + h * (barW+2));
    const y = Math.round(chartY + (chartH - bh));
    bars += `<rect x="${x}" y="${y}" width="${Math.max(1,Math.floor(barW))}" height="${bh}" rx="3" fill="${acc}" opacity="${val?0.9:0.25}"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${bg}"/>
  <text x="${pad}" y="${pad+8}" fill="${sub}" font-size="14">NZ AutoTech • Paymark • ${ymd}</text>
  <text x="${pad}" y="${pad+56}" fill="${fg}" font-size="36" font-weight="700">Transactions Summary</text>
  <g transform="translate(${pad},${pad+76})">
    <rect x="0" y="0" width="${(width-pad*2)}" height="88" rx="12" fill="#111A2C"/>
    <text x="16" y="30" fill="${sub}" font-size="14">Count</text>
    <text x="16" y="64" fill="${fg}" font-size="28" font-weight="700">${total}</text>
    <text x="160" y="30" fill="${sub}" font-size="14">Purchase</text>
    <text x="160" y="64" fill="${fg}" font-size="28" font-weight="700">$${purchase.toFixed(2)}</text>
    <text x="340" y="30" fill="${sub}" font-size="14">Cash</text>
    <text x="340" y="64" fill="${fg}" font-size="28" font-weight="700">$${cashout.toFixed(2)}</text>
    <text x="${(width-pad*2)-200}" y="30" fill="${sub}" font-size="14">Last TXN (NZ)</text>
    <text x="${(width-pad*2)-200}" y="64" fill="${fg}" font-size="24" font-weight="600">${lastNZ}</text>
  </g>
  <text x="${pad}" y="${chartY-16}" fill="${sub}" font-size="14">Transactions by Hour (NZ)</text>
  <rect x="${chartX}" y="${chartY}" width="${chartW}" height="${chartH}" rx="8" fill="#0F1B33"/>
  ${bars}
  <text x="${pad}" y="${height-pad}" fill="${sub}" font-size="12">Generated by Paymark Reporter</text>
</svg>`;
}

async function fetchTx(url, bearer, acceptHeader) {
  const accept = acceptHeader || process.env.PAYMARK_ACCEPT || "application/vnd.paymark_api+json;version=2.0";
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "Accept": accept,
      "Origin": "https://insights.paymark.co.nz",
      "Referer": "https://insights.paymark.co.nz/",
      "User-Agent": "Mozilla/5.0 PaymarkReporter/16g",
      "Accept-Language": "en-NZ,en;q=0.9"
    },
    cache: "no-store"
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, bodyText: text, accept };
}

export default async function handler(req, res) {
  try {
    const urlObj = new URL(req.url, "http://local");
    const debug = urlObj.searchParams.get("debug") === "1";
    const page = urlObj.searchParams.get("page") || "1";
    const limit = urlObj.searchParams.get("limit") || "100";
    const overrideAccept = urlObj.searchParams.get("accept") || "";
    const overrideToken = urlObj.searchParams.get("token") || ""; // NEW

    // allow per-call token override to avoid redeploy on expiry
    const bearer = overrideToken || getBearerFromEnv();
    if (!bearer) return res.status(401).json({ ok:false, error:"missing or expired token; pass ?token=<ACCESS_TOKEN> or set PAYMARK_BEARER." });

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

    const resp = await fetchTx(apiUrl.toString(), bearer, overrideAccept);
    if (!resp.ok) {
      return res.status(resp.status).json({ ok:false, status: resp.status, accept: resp.accept, sample: (resp.bodyText || "").slice(0,300), api: apiUrl.toString() });
    }

    const rows = normalizeRows(resp.json);

    if (debug) {
      return res.status(200).json({ ok:true, count: rows.length, status: resp.status, accept: resp.accept, api: apiUrl.toString(), sample: rows[0] ?? null });
    }

    const csv = buildCsvUI(rows);
    const svg = buildSvgSummary(rows, ymd);

    const mailEnv = {
      MAIL_TO: process.env.MAIL_TO,
      MAIL_FROM: process.env.MAIL_FROM,
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS
    };
    for (const k of Object.keys(mailEnv)) if (!mailEnv[k]) return res.status(500).json({ ok:false, error:`缺少邮件环境变量: ${k}` });

    const transporter = nodemailer.createTransport({
      host: mailEnv.SMTP_HOST, port: Number(mailEnv.SMTP_PORT || 587), secure: false,
      auth: { user: mailEnv.SMTP_USER, pass: mailEnv.SMTP_PASS }
    });
    await transporter.sendMail({
      from: mailEnv.MAIL_FROM, to: mailEnv.MAIL_TO,
      subject: `Paymark Transactions — ${ymd} (NZ)`,
      text: `Attached are today's transactions (${ymd} NZ). Count: ${rows.length}.`,
      attachments: [
        { filename: `transactions_${ymd}.csv`, content: csv, contentType: "text/csv; charset=utf-8" },
        { filename: `transactions_${ymd}.svg`, content: svg, contentType: "image/svg+xml" }
      ]
    });
    res.status(200).json({ ok:true, sent:true, count: rows.length, dateNZ: ymd });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
}
