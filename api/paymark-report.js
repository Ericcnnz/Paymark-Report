
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import nodemailer from "nodemailer";
import { DateTime } from "luxon";

export const config = { runtime: "nodejs", memory: 1024, maxDuration: 60 };

const {
  PAYMARK_USER,
  PAYMARK_PASS,
  PAYMARK_COOKIE,
  PAYMARK_LS_JSON,
  MAIL_TO,
  MAIL_FROM,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS
} = process.env;

async function setCookiesFromHeader(page, cookieHeader) {
  if (!cookieHeader) return 0;
  const pairs = cookieHeader.split(/;\s*/).map(s => s.trim()).filter(Boolean);
  const cookies = pairs.map(p => {
    const idx = p.indexOf("=");
    const name = idx >= 0 ? p.slice(0, idx) : p;
    const value = idx >= 0 ? p.slice(idx+1) : "";
    return { name, value, domain: "insights.paymark.co.nz", path: "/", httpOnly: false, secure: true };
  });
  await page.setCookie(...cookies);
  return cookies.length;
}

async function setLocalStorageFromJson(page, jsonStr) {
  if (!jsonStr) return 0;
  let obj = {};
  try { obj = JSON.parse(jsonStr); } catch (e) { console.log("LS JSON parse error:", String(e)); return 0; }
  const count = await page.evaluate((kv) => {
    try {
      const entries = Object.entries(kv || {});
      for (const [k, v] of entries) {
        if (typeof k === "string") {
          localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
        }
      }
      return entries.length;
    } catch (e) {
      return -1;
    }
  }, obj);
  return count;
}

async function loginAndGrab(page, timeFromUTC, timeToUTC, mode) {
  page.setDefaultNavigationTimeout(0);
  page.setDefaultTimeout(120000);
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

  console.log("Mode:", mode);
  await page.goto("https://insights.paymark.co.nz/", { waitUntil: "domcontentloaded", timeout: 0 });

  if (mode === "ls" && PAYMARK_LS_JSON) {
    const n = await setLocalStorageFromJson(page, PAYMARK_LS_JSON);
    console.log("LocalStorage keys set:", n);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 0 });
  }

  if (mode === "cookie" && PAYMARK_COOKIE) {
    const n = await setCookiesFromHeader(page, PAYMARK_COOKIE);
    console.log("Cookies set:", n);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 0 });
  }

  if (mode === "form") {
    await page.waitForSelector('input[type="email"], input[name="username"], input#username', { timeout: 120000 });
    const emailSel = await page.$('input[type="email"], input[name="username"], input#username');
    const passSel  = await page.$('input[type="password"], input[name="password"], input#password');
    if (!emailSel || !passSel) throw new Error("找不到登录输入框（需要调整选择器）。");
    await emailSel.click({ clickCount: 3 });
    await emailSel.type(PAYMARK_USER, { delay: 10 });
    await passSel.type(PAYMARK_PASS, { delay: 10 });
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const hit = btns.find((b) => {
        const t = (b.innerText || b.value || '').toLowerCase();
        return /sign\s*in|log\s*in|login|continue/.test(t);
      });
      if (hit) { hit.click(); return true; }
      const form = document.querySelector('form');
      if (form) {
        if (form.requestSubmit) { form.requestSubmit(); } else { form.submit(); }
        return true;
      }
      return false;
    });
    if (!clicked) await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
  }

  const url = new URL("https://insights.paymark.co.nz/transaction");
  url.searchParams.set("cardAcceptorIdCode", "10243212");
  url.searchParams.set("cardType", "All Cards");
  url.searchParams.set("limit", "100");
  url.searchParams.set("name", "AUTO TECH REPAIR&SERVICES");
  url.searchParams.set("page", "1");
  url.searchParams.set("transactionCategory", "All Types");
  url.searchParams.set("transactionTimeFrom", timeFromUTC);
  url.searchParams.set("transactionTimeTo", timeToUTC);
  console.log("Goto:", url.toString());
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 0 });

  if (page.url().includes("account.paymark.nz")) {
    console.log("Bounced to login; try fallbacks");
    if (mode !== "ls" && PAYMARK_LS_JSON) {
      await page.goto("https://insights.paymark.co.nz/", { waitUntil: "domcontentloaded", timeout: 0 });
      const n = await setLocalStorageFromJson(page, PAYMARK_LS_JSON);
      console.log("Fallback LS set:", n);
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 0 });
    } else if (mode !== "cookie" && PAYMARK_COOKIE) {
      await page.goto("https://insights.paymark.co.nz/", { waitUntil: "domcontentloaded", timeout: 0 });
      const n = await setCookiesFromHeader(page, PAYMARK_COOKIE);
      console.log("Fallback cookies set:", n);
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 0 });
    }
  }

  await page.waitForFunction(() => {
    return !!document.querySelector("table") || document.body.innerText.includes("No transactions to display.");
  }, { timeout: 120000 });

  const rows = await page.$$eval("table tbody tr", trs => {
    return trs.map(tr => {
      const tds = Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim());
      return {
        time: tds[0] || "",
        cardType: tds[1] || "",
        transactionType: tds[2] || "",
        amount: tds[3] || "",
        authCode: tds[4] || "",
        ref: tds[5] || ""
      };
    });
  });

  return { rows };
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, "http://local");
  const debug = urlObj.searchParams.get("debug") === "1";
  const forceLS = urlObj.searchParams.get("ls") === "1";
  const forceCookie = urlObj.searchParams.get("cookie") === "1";

  try {
    if (!MAIL_TO || !MAIL_FROM) throw new Error("请设置 MAIL_TO 与 MAIL_FROM 环境变量。");
    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) throw new Error("请设置 SMTP_* 环境变量。");

    let mode = "form";
    if (forceLS) mode = "ls";
    else if (forceCookie) mode = "cookie";
    else if (PAYMARK_LS_JSON) mode = "ls";
    else if (PAYMARK_COOKIE) mode = "cookie";
    else if (!PAYMARK_USER || !PAYMARK_PASS) throw new Error("缺少登录方式：请设置 PAYMARK_USER/PAYMARK_PASS 或 PAYMARK_COOKIE 或 PAYMARK_LS_JSON。");

    const nzNow = DateTime.now().setZone("Pacific/Auckland");
    const startNZ = nzNow.startOf("day");
    const endNZ   = nzNow.endOf("day");
    const timeFromUTC = startNZ.toUTC().toISO();
    const timeToUTC   = endNZ.toUTC().toISO();
    const ymd = nzNow.toFormat("yyyy-LL-dd");

    const executablePath = await chromium.executablePath();
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless
    });
    const page = await browser.newPage();

    const { rows } = await loginAndGrab(page, timeFromUTC, timeToUTC, mode);

    const headers = ["Time (NZ)", "Card Type", "Txn Type", "Amount", "Auth Code", "Reference"];
    const csv = [headers.join(",")].concat(rows.map(r => [
      (r.time || "").replaceAll(",", " "),
      (r.cardType || "").replaceAll(",", " "),
      (r.transactionType || "").replaceAll(",", " "),
      (r.amount || "").replaceAll(",", ""),
      (r.authCode || "").replaceAll(",", " "),
      (r.ref || "").replaceAll(",", " ")
    ].join(","))).join("\n");

    if (debug) {
      await browser.close();
      return res.status(200).json({ ok: true, count: rows.length, mode });
    }

    await browser.close();

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    const attachments = [{ filename: `transactions_${ymd}.csv`, content: csv, contentType: "text/csv; charset=utf-8" }];

    await transporter.sendMail({
      from: MAIL_FROM,
      to: MAIL_TO,
      subject: `Paymark Transactions — ${ymd} (NZ)`,
      text: `Attached are today's transactions (${ymd} NZ). Count: ${rows.length}.`
    ,  attachments });

    res.status(200).json({ ok: true, sent: true, count: rows.length, dateNZ: ymd });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}
