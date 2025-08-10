
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import nodemailer from "nodemailer";
import { DateTime } from "luxon";

export const config = { runtime: "nodejs", memory: 1024, maxDuration: 60 };

const {
  PAYMARK_USER,
  PAYMARK_PASS,
  MAIL_TO,
  MAIL_FROM,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS
} = process.env;

async function loginAndGrab(page, timeFromUTC, timeToUTC) {
  page.setDefaultNavigationTimeout(0);
  page.setDefaultTimeout(120000);
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

  console.log("Phase: open_home");
  await page.goto("https://insights.paymark.co.nz/", { waitUntil: "domcontentloaded", timeout: 0 });
  console.log("URL:", page.url());

  console.log("Phase: wait_login_inputs");
  await page.waitForSelector('input[type="email"], input[name="username"], input#username', { timeout: 120000 });
  const emailSel = await page.$('input[type="email"], input[name="username"], input#username');
  const passSel  = await page.$('input[type="password"], input[name="password"], input#password');
  if (!emailSel || !passSel) throw new Error("找不到登录输入框（需要调整选择器）。");

  console.log("Phase: fill_credentials");
  await emailSel.click({ clickCount: 3 });
  await emailSel.type(PAYMARK_USER, { delay: 10 });
  await passSel.type(PAYMARK_PASS, { delay: 10 });

  console.log("Phase: try_submit_login");
  // 优先点击“Sign in/Log in/Continue”按钮；否则回退为回车或提交 form
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    const hit = btns.find((b) => {
      const t = (b.innerText || b.value || '').toLowerCase();
      return /sign\s*in|log\s*in|login|continue/.test(t);
    });
    if (hit) { hit.click(); return true; }
    const form = document.querySelector('form');
    if (form) {
      // @ts-ignore
      if (form.requestSubmit) { /* @ts-ignore */ form.requestSubmit(); } else { /* @ts-ignore */ form.submit(); }
      return true;
    }
    return false;
  });
  if (!clicked) {
    await page.keyboard.press("Enter");
  }

  console.log("Phase: wait_after_login");
  await page.waitForFunction(() => {
    const host = location.hostname;
    return host.includes("insights.paymark.co.nz") || document.querySelector('a[href*="/transaction"]');
  }, { timeout: 120000 });

  // 点击顶部 Transactions 标签（如果可见）
  try {
    console.log("Phase: click_transactions_tab_if_any");
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const el = links.find((node) => /transactions/i.test(node.textContent || ''));
      if (el) el.click();
    });
    await page.waitForTimeout(800);
  } catch (e) {
    console.log("Transactions tab click skipped:", String(e));
  }

  // 直接跳到带参数的交易页面（今日窗口）
  const url = new URL("https://insights.paymark.co.nz/transaction");
  url.searchParams.set("cardAcceptorIdCode", "10243212");
  url.searchParams.set("cardType", "All Cards");
  url.searchParams.set("limit", "100");
  url.searchParams.set("name", "AUTO TECH REPAIR&SERVICES");
  url.searchParams.set("page", "1");
  url.searchParams.set("transactionCategory", "All Types");
  url.searchParams.set("transactionTimeFrom", timeFromUTC);
  url.searchParams.set("transactionTimeTo", timeToUTC);
  console.log("Phase: goto_transactions_url", url.toString());
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 0 });

  console.log("Phase: wait_for_table_or_empty");
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

  let summaryPngBase64 = null;
  const summaryEl = await page.$('[data-testid="transaction-summary"], .summary, .total');
  if (summaryEl) {
    const clip = await summaryEl.boundingBox();
    if (clip) {
      const buf = await page.screenshot({ clip, type: "png" });
      summaryPngBase64 = buf.toString("base64");
    }
  }
  return { rows, summaryPngBase64 };
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, "http://local");
  const debug = urlObj.searchParams.get("debug") === "1";

  try {
    if (!PAYMARK_USER || !PAYMARK_PASS) throw new Error("请设置 PAYMARK_USER 与 PAYMARK_PASS 环境变量。");
    if (!MAIL_TO || !MAIL_FROM) throw new Error("请设置 MAIL_TO 与 MAIL_FROM 环境变量。");
    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) throw new Error("请设置 SMTP_* 环境变量。");

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

    const { rows, summaryPngBase64 } = await loginAndGrab(page, timeFromUTC, timeToUTC);

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
    if (summaryPngBase64) {
      attachments.push({ filename: `summary_${ymd}.png`, content: Buffer.from(summaryPngBase64, "base64"), contentType: "image/png" });
    }

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
