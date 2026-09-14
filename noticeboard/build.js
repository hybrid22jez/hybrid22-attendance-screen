// noticeboard/build.js
//
// Reads notices from the Google Sheet, drops anything outside its
// show-from/show-until window, and writes a static HTML page to
// docs/noticeboard/index.html for GitHub Pages to serve.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ---- Fill these in ----
const SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE'; // from the sheet's URL
const SHEET_RANGE = 'Form Responses 1!A2:F';
// ------------------------

function melbourneToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
}

async function getRows() {
  const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });
  return res.data.values || [];
}

function toNotices(rows) {
  // Expected columns: Timestamp, Notice title, Detail, Show from, Show until, Added by
  return rows
    .map(row => ({
      title: row[1] || '',
      detail: row[2] || '',
      showFrom: row[3] || '',
      showUntil: row[4] || '',
    }))
    .filter(n => n.title.trim().length > 0);
}

function parseAuDate(str, fallback) {
  // Expects dd/mm/yyyy (as set in the sheet's locale). Returns an ISO
  // yyyy-mm-dd string so it can be compared safely against today's date.
  if (!str) return fallback;
  const [day, month, year] = str.split('/');
  if (!day || !month || !year) return fallback;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function isLive(notice, today) {
  const from = parseAuDate(notice.showFrom, '0000-01-01');
  const until = parseAuDate(notice.showUntil, '9999-12-31');
  return from <= today && today <= until;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderPage(notices) {
  const items = notices.length
    ? notices.map(n => `
      <div class="notice">
        <h2>${escapeHtml(n.title)}</h2>
        <p>${escapeHtml(n.detail)}</p>
      </div>`).join('\n')
    : `<div class="empty">Nothing new this week — full send in class.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hybrid 22 — Noticeboard</title>
<style>
  body{
    margin:0;
    background:#141414;
    color:#FAF9F6;
    font-family:'Helvetica Neue', Arial, sans-serif;
    padding:32px 24px;
  }
  h1{
    font-size:22px;
    letter-spacing:0.02em;
    color:#C23B22;
    margin:0 0 28px;
  }
  .notice{
    border-bottom:1px solid #333;
    padding:20px 0;
  }
  .notice:last-child{border-bottom:none;}
  .notice h2{
    font-size:28px;
    margin:0 0 6px;
  }
  .notice p{
    font-size:19px;
    color:#D8D5CC;
    margin:0;
    line-height:1.4;
  }
  .empty{
    font-size:20px;
    color:#9A968C;
    padding:20px 0;
  }
</style>
</head>
<body>
  <h1>Hybrid 22 — This Week</h1>
  ${items}
</body>
</html>`;
}

async function main() {
  const today = melbourneToday();
  const rows = await getRows();
  const notices = toNotices(rows).filter(n => isLive(n, today));

  const outDir = path.join(__dirname, '..', 'docs', 'noticeboard');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), renderPage(notices));

  console.log(`Wrote ${notices.length} live notice(s) for ${today}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
