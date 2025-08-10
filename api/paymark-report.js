
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
  // 登录
  await page.goto("https://insights.paymark.co.nz/", { waitUntil: "networkidle2" });

  // 等待并尝试找到登录框（根据实际页面微调）
  await page.waitForSelector('input[type="email"], input[name="username"], input#username', { timeout: 60000 });
  const emailSel = await page.$('input[type="email"], input[name="username"], input#username');
  const passSel  = await page.$('input[type="password"], input[name="password"], input#password');
  if (!emailSel || !passSel) throw new Error("找不到登录输入框（需要调整选择器）。");

  await emailSel.click({ clickCount: 3 });
  await emailSel.type(PAYMARK_USER, { delay: 10 });
  await passSel.type(PAYMARK_PASS, { delay: 10 });

  await Promise.all([
    page.keyboard.press("Enter"),
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 })
  ]);

  // 抓取交易（支持翻页）
  const allRows = [];
  let pageIndex = 1;
  while (pageIndex <= 10) {
    const url = new URL("https://insights.paymark.co.nz/transaction");
    url.searchParams.set("cardAcceptorIdCode", "10243212");
    url.searchParams.set("cardType", "All Cards");
    url.searchParams.set("limit", "100");
    url.searchParams.set("name", "AUTO TECH REPAIR&SERVICES");
    url.searchParams.set("page", String(pageIndex));
    url.searchParams.set("transactionCategory", "All Types");
    url.searchParams.set("transactionTimeFrom", timeFromUTC);
    url.searchParams.set("transactionTimeTo", timeToUTC);

    await page.goto(url.toString(), { waitUntil: "networkidle2" });
    await page.waitForSelector("table", { timeout: 60000 }).catch(() => {});

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

    if (!rows || rows.length === 0) break;
    allRows.push(...rows);
    if (rows.length < 100) break;
    pageIndex += 1;
  }

  // 尝试截图 summary
  let summaryPngBase64 = null;
  const summaryEl = await page.$('[data-testid="transaction-summary"], .summary, .total');
  if (summaryEl) {
    const clip = await summaryEl.boundingBox();
    if (clip) {
      const buf = await page.screenshot({ clip, type: "png" });
      summaryPngBase64 = buf.toString("base64");
    }
  }

  return { rows: allRows, summaryPngBase64 };
}

export default async function handler(req, res) {
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

    await browser.close();

    // 邮件
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
      attachments.push({
        filename: `summary_${ymd}.png`,
        content: Buffer.from(summaryPngBase64, "base64"),
        contentType: "image/png"
      });
    }

    await transporter.sendMail({
      from: MAIL_FROM,
      to: MAIL_TO,
      subject: `Paymark Transactions — ${ymd} (NZ)`,
      text: `Attached are today's transactions (${ymd} NZ). Count: ${rows.length}.`,
      attachments
    });

    res.status(200).json({ ok: true, count: rows.length, dateNZ: ymd });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}
