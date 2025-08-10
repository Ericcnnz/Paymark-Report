
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import nodemailer from "nodemailer";
import { DateTime } from "luxon";

puppeteerExtra.use(StealthPlugin());

export const config = { runtime: "nodejs", memory: 1024, maxDuration: 60 };

const {
  PAYMARK_USER,
  PAYMARK_PASS,
  PAYMARK_COOKIE,            // Cookie for insights.paymark.co.nz (optional)
  PAYMARK_COOKIE_ACCOUNT,    // Cookie for account.paymark.nz (optional)
  PAYMARK_LS_JSON,
  MAIL_TO,
  MAIL_FROM,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS
} = process.env;

async function setCookieHeader(page, cookieHeader, domain) {
  if (!cookieHeader) return 0;
  const pairs = cookieHeader.split(/;\s*/).map(s => s.trim()).filter(Boolean);
  const cookies = pairs.map(p => {
    const idx = p.indexOf("=");
    const name = idx >= 0 ? p.slice(0, idx) : p;
    const value = idx >= 0 ? p.slice(idx+1) : "";
    return { name, value, domain, path: "/", httpOnly: false, secure: true };
  });
  await page.setCookie(...cookies);
  return cookies.length;
}

async function setLocalStorage(page, jsonStr) {
  if (!jsonStr) return 0;
  let obj = {};
  try { obj = JSON.parse(jsonStr); } catch { return 0; }
  const count = await page.evaluate((kv) => {
    const entries = Object.entries(kv || {});
    for (const [k, v] of entries) {
      localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    return entries.length;
  }, obj);
  return count;
}

async function launch() {
  const executablePath = await chromium.executablePath();
  const browser = await puppeteerExtra.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless
  });
  return browser;
}

async function runFlow(page, timeFromUTC, timeToUTC) {
  page.setDefaultNavigationTimeout(0);
  page.setDefaultTimeout(120000);
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

  // 1) Prepare both origins
  console.log("Phase: open account origin");
  await page.goto("https://account.paymark.nz/", { waitUntil: "domcontentloaded", timeout: 0 });
  if (PAYMARK_COOKIE_ACCOUNT) {
    const n = await setCookieHeader(page, PAYMARK_COOKIE_ACCOUNT, "account.paymark.nz");
    console.log("Cookies(account) set:", n);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 0 });
  }

  console.log("Phase: open insights origin");
  await page.goto("https://insights.paymark.co.nz/", { waitUntil: "domcontentloaded", timeout: 0 });
  if (PAYMARK_LS_JSON) {
    const nls = await setLocalStorage(page, PAYMARK_LS_JSON);
    console.log("LocalStorage(insights) set:", nls);
  }
  if (PAYMARK_COOKIE) {
    const nin = await setCookieHeader(page, PAYMARK_COOKIE, "insights.paymark.co.nz");
    console.log("Cookies(insights) set:", nin);
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: 0 });

  // 2) Go directly to transactions
  const url = new URL("https://insights.paymark.co.nz/transaction");
  url.searchParams.set("cardAcceptorIdCode", "10243212");
  url.searchParams.set("cardType", "All Cards");
  url.searchParams.set("limit", "100");
  url.searchParams.set("name", "AUTO TECH REPAIR&SERVICES");
  url.searchParams.set("page", "1");
  url.searchParams.set("transactionCategory", "All Types");
  url.searchParams.set("transactionTimeFrom", timeFromUTC);
  url.searchParams.set("transactionTimeTo", timeToUTC);
  console.log("Phase: goto transactions", url.toString());
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 0 });

  // 3) If still redirected to login, try minimal form submit
  if (page.url().includes("account.paymark.nz") && PAYMARK_USER && PAYMARK_PASS) {
    console.log("Phase: still at account login, try form submit quickly");
    try {
      await page.waitForSelector('input[type="email"], input[name="username"], input#username', { timeout: 8000 });
      const emailSel = await page.$('input[type="email"], input[name="username"], input#username');
      const passSel  = await page.$('input[type="password"], input[name="password"], input#password');
      if (emailSel && passSel) {
        await emailSel.click({ clickCount: 3 }); await emailSel.type(PAYMARK_USER, { delay: 5 });
        await passSel.type(PAYMARK_PASS, { delay: 5 });
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
          const hit = btns.find(b => (/sign\s*in|log\s*in|login|continue/i).test((b.innerText || b.value || '')));
          if (hit) hit.click(); else document.querySelector('form')?.dispatchEvent(new Event('submit', {bubbles:true}));
        });
        await page.waitForTimeout(1500);
      }
    } catch {}
    // back to insights
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 0 });
  }

  console.log("Phase: wait content");
  await page.waitForFunction(() => {
    return !!document.querySelector("table") || document.body.innerText.includes("No transactions to display.");
  }, { timeout: 120000 });

  const rows = await page.$$eval("table tbody tr", trs => {
    return trs.map(tr => {
      const tds = Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim());
      return {
        time: tds[0] || "", cardType: tds[1] || "", transactionType: tds[2] || "",
        amount: tds[3] || "", authCode: tds[4] || "", ref: tds[5] || ""
      };
    });
  });
  return rows;
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, "http://local");
  const debug = urlObj.searchParams.get("debug") === "1";

  try {
    if (!MAIL_TO || !MAIL_FROM) throw new Error("请设置 MAIL_TO 与 MAIL_FROM 环境变量。");
    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) throw new Error("请设置 SMTP_* 环境变量。");

    const nzNow = DateTime.now().setZone("Pacific/Auckland");
    const startNZ = nzNow.startOf("day");
    const endNZ   = nzNow.endOf("day");
    const timeFromUTC = startNZ.toUTC().toISO();
    const timeToUTC   = endNZ.toUTC().toISO();
    const ymd = nzNow.toFormat("yyyy-LL-dd");

    const browser = await launch();
    const page = await browser.newPage();

    const rows = await runFlow(page, timeFromUTC, timeToUTC);

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
      return res.status(200).json({ ok: true, count: rows.length });
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
      text: `Attached are today's transactions (${ymd} NZ). Count: ${rows.length}.`,
      attachments
    });

    res.status(200).json({ ok: true, sent: true, count: rows.length, dateNZ: ymd });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}
