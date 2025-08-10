
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
  // Disable nav timeout, extend step timeouts
  page.setDefaultNavigationTimeout(0);
  page.setDefaultTimeout(120000);
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

  console.log("Phase: open_home");
  await page.goto("https://insights.paymark.co.nz/", { waitUntil: "domcontentloaded", timeout: 0 });
  console.log("URL after home goto:", page.url());

  console.log("Phase: wait_login_inputs");
  await page.waitForSelector('input[type="email"], input[name="username"], input#username', { timeout: 120000 });
  const emailSel = await page.$('input[type="email"], input[name="username"], input#username');
  const passSel  = await page.$('input[type="password"], input[name="password"], input#password');
  if (!emailSel || !passSel) throw new Error("找不到登录输入框（需要调整选择器）。");

  console.log("Phase: fill_username");
  await emailSel.click({ clickCount: 3 });
  await emailSel.type(PAYMARK_USER, { delay: 10 });
  await passSel.type(PAYMARK_PASS, { delay: 10 });

  console.log("Phase: submit_login");
  await page.keyboard.press("Enter");
  console.log("Pressed Enter, wait for post-login UI");

  // Wait until Transactions tab appears or any button shows up (post-login)
  try {
    console.log("Phase: wait_post_login_ui");
    await Promise.race([
      page.waitForXPath("//*[contains(., 'Transactions')]", { timeout: 120000 }),
      page.waitForSelector("button", { timeout: 120000 })
    ]);
  } catch (e) {
    console.log("post-login UI not detected fast, continue anyway");
  }

  // Go to home again to ensure top nav present
  await page.goto("https://insights.paymark.co.nz/", { waitUntil: "domcontentloaded", timeout: 0 });

  // Click top 'Transactions' tab
  try {
    console.log("Phase: click_transactions_tab");
    const [tab] = await page.$x("//a[contains(., 'Transactions') or contains(., 'TRANSACTIONS')]");
    if (tab) { await tab.click(); await page.waitForTimeout(800); }
  } catch (e) {
    console.log("Transactions tab click error", String(e));
  }

  // Ensure we are on /transaction page (to apply filters via URL)
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
  console.log("URL after transactions goto:", page.url());

  // Wait for either table or "No transactions" text
  console.log("Phase: wait_for_table_or_empty");
  await Promise.race([
    page.waitForSelector("table", { timeout: 120000 }),
    page.waitForXPath("//*[contains(., 'No transactions to display.')]", { timeout: 120000 })
  ]).catch(() => {});

  // Extract rows if table exists
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

  // Try capture summary area if any
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

    // CSV
    const headers = ["Time (NZ)", "Card Type", "Txn Type", "Amount", "Auth Code", "Reference"];
    const csvLines = [headers.join(",")];
    for (const r of rows) {
      const line = [
        (r.time || "").replaceAll(",", " "),
        (r.cardType || "").replaceAll(",", " "),
        (r.transactionType || "").replaceAll(",", " "),
        (r.amount || "").replaceAll(",", ""),
        (r.authCode || "").replaceAll(",", " "),
        (r.ref || "").replaceAll(",", " ")
      ].join(",");
      csvLines.push(line);
    }
    const csv = csvLines.join("\n");

    const debugPayload = { ok: true, count: rows.length };
    if (debug) {
      await browser.close();
      return res.status(200).json(debugPayload);
    }

    await browser.close();

    // Email
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    const attachments = [
      { filename: `transactions_${ymd}.csv`, content: csv, contentType: "text/csv; charset=utf-8" }
    ];
    if (summaryPngBase64) {
      attachments.push({ filename: `summary_${ymd}.png`, content: Buffer.from(summaryPngBase64, "base64"), contentType: "image/png" });
    }

    await transporter.sendMail({
      from: MAIL_FROM,
      to: MAIL_TO,
      subject: `Paymark Transactions — ${ymd} (NZ)`,
      text: `Attached are today's transactions (${ymd} NZ). Count: ${csvLines.length - 1}.`,
      attachments
    });

    res.status(200).json({ ok: true, sent: true, count: csvLines.length - 1, dateNZ: ymd });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}
