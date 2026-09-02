import nodemailer from "nodemailer";

const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;
if (!USER || !PASS) {
  throw new Error("SMTP_USER or SMTP_PASS is not set in .env");
}
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: USER,
    pass: PASS,
  },
});

type SummaryEmailParams = {
  to: string;
  videoId: string;
  ready: string[];
  failed: string[];
};

const FRONTEND_URL = process.env.FRONTEND_URL;
if (!FRONTEND_URL) {
  throw new Error("FRONTEND_URL is not set in .env");
}

const SMTP_USER = process.env.SMTP_USER;
if (!SMTP_USER) {
  throw new Error("SMTP_USER is not set in .env");
}

export async function sendVideoSummaryEmail({
  to,
  videoId,
  ready,
  failed,
}: SummaryEmailParams) {
  const videoUrl = `${FRONTEND_URL}/videos/${videoId}`;

  const subject =
    failed.length === 0
      ? "Your video is ready"
      : ready.length === 0
        ? "Your video failed to process"
        : "Your video finished with some errors";

  const successLine = ready.length
    ? `<p>Ready: ${ready.map((r) => `${r}p`).join(", ")}</p>`
    : "";

  const failLine = failed.length
    ? `<p>Failed: ${failed.map((r) => `${r}p`).join(", ")}. <a href="${videoUrl}">Retry from your video page</a>.</p>`
    : "";

  await transporter.sendMail({
    from: `"StreamForge" <${SMTP_USER}>`,
    to,
    subject,
    html: `${successLine}${failLine}<p><a href="${videoUrl}">View video</a></p>`,
  });
}
