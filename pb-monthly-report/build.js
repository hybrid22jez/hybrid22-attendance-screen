// pb-monthly-report/build.js
//
// Runs daily. Does nothing unless today is the last day of the month
// (Melbourne time), in which case it reads the PB board's synced Sheet,
// compiles this month's stats, and emails Kat and Zane.

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');

// ---- Fill these in ----
const SHEET_ID = '1_bzQsJkbg_QUfD9BWWStT1qUFkHedYfekNnDOTZ9xC4'; // the "PB Board Sync" sheet's URL
const RECIPIENTS = ['zane.hybrid22@gmail.com', 'kat.j.fitness@gmail.com', 'jezaem.hybrid22@gmail.com'];
// ------------------------

const STATE_PATH = path.join(__dirname, 'state.json');

function melbourneDateParts(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  const iso = d.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' }); // YYYY-MM-DD
  const [year, month, day] = iso.split('-');
  return { iso, year, month, day };
}

function isLastDayOfMonth() {
  const today = melbourneDateParts(0);
  const tomorrow = melbourneDateParts(1);
  return tomorrow.month !== today.month;
}

// Mirrors the board's own formatValue() — mm:ss under an hour, h:mm:ss beyond.
function formatTimeValue(totalSeconds) {
  const total = Math.round(totalSeconds);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = n => (n < 10 ? '0' : '') + n;
  return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

function formatValue(unit, value) {
  return unit === 'time' ? formatTimeValue(value) : `${value}kg`;
}

async function getSheetRows(sheets, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return res.data.values || [];
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    header.forEach((key, i) => { obj[key] = row[i]; });
    return obj;
  });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function main() {
  const forceSend = process.env.FORCE_SEND === 'true';
  if (!forceSend && !isLastDayOfMonth()) {
    console.log('Not the last day of the month — nothing to do.');
    return;
  }
  if (forceSend) {
    console.log('FORCE_SEND is set — running regardless of date (test mode).');
  }

  const thisMonth = melbourneDateParts(0).iso.slice(0, 7); // YYYY-MM

  const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const entryRows = rowsToObjects(await getSheetRows(sheets, 'Entries!A1:J'));
  const historyRows = rowsToObjects(await getSheetRows(sheets, 'History!A1:H'));

  // ---- New PBs this month (from Entries — each row is a member's current best) ----
  const newPbsThisMonth = entryRows.filter(r => (r.updatedAt || '').slice(0, 7) === thisMonth);

  // ---- Parse history records, find this month's attempts + improvers ----
  const participantsThisMonth = new Set();
  const genderCount = { M: 0, F: 0 };
  const kindCount = { kg: 0, time: 0 };
  let totalAttemptsThisMonth = 0;
  const improvers = [];

  historyRows.forEach(r => {
    let records = [];
    try { records = JSON.parse(r.records || '[]'); } catch (e) { records = []; }
    records.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const inMonth = records.filter(rec => (rec.date || '').slice(0, 7) === thisMonth);
    if (inMonth.length === 0) return;

    totalAttemptsThisMonth += inMonth.length;
    participantsThisMonth.add(r.memberSlug);
    if (r.gender === 'F') genderCount.F++; else genderCount.M++;
    if (r.unit === 'time') kindCount.time++; else kindCount.kg++;

    const before = records.filter(rec => (rec.date || '').slice(0, 7) < thisMonth).pop();
    const lastInMonth = inMonth[inMonth.length - 1];
    if (before) {
      const delta = lastInMonth.weight - before.weight;
      if (delta !== 0) {
        improvers.push({
          member: r.member, lift: r.liftName, unit: r.unit,
          delta, improved: r.unit === 'time' ? delta < 0 : delta > 0,
        });
      }
    }
  });

  const topImprovers = improvers
    .filter(i => i.improved)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);

  // ---- Month-over-month participation trend ----
  const state = loadState();
  const lastMonthParticipants = state.lastParticipantCount;
  const participantDelta = (typeof lastMonthParticipants === 'number')
    ? participantsThisMonth.size - lastMonthParticipants
    : null;

  saveState({ lastParticipantCount: participantsThisMonth.size, lastRunMonth: thisMonth });

  // ---- Compose the email ----
  const newPbLines = newPbsThisMonth
    .map(r => `  - ${r.member} — ${r.liftName} (${r.reps}RM): ${formatValue(r.unit, r.weight)}`)
    .join('\n') || '  (none logged this month)';

  const improverLines = topImprovers
    .map(i => {
      const change = i.unit === 'time'
        ? `${Math.abs(i.delta) >= 60 ? formatTimeValue(Math.abs(i.delta)) : Math.abs(i.delta) + 's'} faster`
        : `${i.delta > 0 ? '+' : ''}${i.delta}kg`;
      return `  - ${i.member} — ${i.lift}: ${change}`;
    })
    .join('\n') || '  (not enough data yet to compare)';

  const trendLine = participantDelta === null
    ? 'No prior month on record yet to compare against.'
    : `${participantDelta >= 0 ? '+' : ''}${participantDelta} vs last month`;

  const body = `
Hybrid 22 — PB Board Monthly Report (${thisMonth})

OVERVIEW
----------------------------------
${participantsThisMonth.size} members logged a lift this month (${trendLine}), with ${newPbsThisMonth.length} new PBs set across ${Object.keys(newPbsThisMonth.reduce((acc, r) => { acc[r.liftName] = true; return acc; }, {})).length} different lifts.

NEW PBs THIS MONTH
----------------------------------
${newPbLines}

TOP IMPROVERS THIS MONTH
----------------------------------
${improverLines}

PARTICIPATION & ENGAGEMENT
----------------------------------
Members who logged at least one lift this month: ${participantsThisMonth.size} (${trendLine})
Gender split: ${genderCount.M} male, ${genderCount.F} female
Running vs lifting attempts: ${kindCount.time} running, ${kindCount.kg} lifting
Total attempts logged this month: ${totalAttemptsThisMonth}
`.trim();

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: RECIPIENTS.join(', '),
    subject: `PB Board — Monthly Report (${thisMonth})`,
    text: body,
  });

  console.log('Monthly PB report sent.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
