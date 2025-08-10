
import { DateTime } from "luxon";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  const nzNow = DateTime.now().setZone("Pacific/Auckland");
  const startNZ = nzNow.startOf("day");
  const endNZ = nzNow.endOf("day");

  const env = {
    PAYMARK_USER: !!process.env.PAYMARK_USER,
    PAYMARK_PASS: !!process.env.PAYMARK_PASS,
    MAIL_TO: process.env.MAIL_TO || "",
    MAIL_FROM: process.env.MAIL_FROM || "",
    SMTP_HOST: process.env.SMTP_HOST || "",
    SMTP_PORT: process.env.SMTP_PORT || "",
    SMTP_USER: process.env.SMTP_USER ? "(set)" : "",
    SMTP_PASS: process.env.SMTP_PASS ? "(set)" : ""
  };

  res.status(200).json({
    ok: true,
    envHints: env,
    nzDate: nzNow.toISO(),
    nzWindowUTC: { from: startNZ.toUTC().toISO(), to: endNZ.toUTC().toISO() }
  });
}
