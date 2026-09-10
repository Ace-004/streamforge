// import nodemailer from "nodemailer";

// const USER = process.env.SMTP_USER;
// const PASS = process.env.SMTP_PASS;
// if (!USER || !PASS) {
//   throw new Error("SMTP_USER or SMTP_PASS is not set in .env");
// }
// // import nodemailer from "nodemailer";
// const transporter = nodemailer.createTransport({
//   service: "gmail",
//   auth: {
//     user: USER,
//     pass: PASS,
//   },
//   family: 4,
//   // nodemailer's TS overloads don't cleanly resolve this valid combination
//   // of options (a known rough edge in @types/nodemailer) — this is correct
//   // and works at runtime; the assertion only silences a type-checker
//   // false positive, not a real bug.
// } as nodemailer.TransportOptions);

// type SummaryEmailParams = {
//   to: string;
//   videoId: string;
//   ready: string[];
//   failed: string[];
// };

// const FRONTEND_URL = process.env.FRONTEND_URL;
// if (!FRONTEND_URL) {
//   throw new Error("FRONTEND_URL is not set in .env");
// }

// export async function sendVideoSummaryEmail({
//   to,
//   videoId,
//   ready,
//   failed,
// }: SummaryEmailParams) {
//   const videoUrl = `${FRONTEND_URL}/videos/${videoId}`;

//   const subject =
//     failed.length === 0
//       ? "Your video is ready"
//       : ready.length === 0
//         ? "Your video failed to process"
//         : "Your video finished with some errors";

//   const successLine = ready.length
//     ? `<p>Ready: ${ready.map((r) => `${r}p`).join(", ")}</p>`
//     : "";

//   const failLine = failed.length
//     ? `<p>Failed: ${failed.map((r) => `${r}p`).join(", ")}. <a href="${videoUrl}">Retry from your video page</a>.</p>`
//     : "";

//   await transporter.sendMail({
//     from: `"StreamForge" <${USER}>`,
//     to,
//     subject,
//     html: `${successLine}${failLine}<p><a href="${videoUrl}">View video</a></p>`,
//   });
// }


import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) {
  throw new Error("RESEND_API_KEY is not set in .env");
}
const resend = new Resend(RESEND_API_KEY);

const EMAIL_FROM = process.env.EMAIL_FROM;
if (!EMAIL_FROM) {
  throw new Error("EMAIL_FROM is not set in .env");
}

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

  const { error } = await resend.emails.send({
    from: EMAIL_FROM!,
    to,
    subject,
    html: `${successLine}${failLine}<p><a href="${videoUrl}">View video</a></p>`,
  });

  if (error) {
    throw new Error(`Resend failed to send email: ${error.message}`);
  }
}
