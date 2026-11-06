import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const answerKeys = [0, 1, 0, 2, 1, 1, 0, 0, 0, 2, 0, 2, 1, 2, 2];

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the local shell environment.");
}

const source = await readFile(resolve(projectRoot, "zona-peka-questions.js"), "utf8");
const questionWindow = {};
runInNewContext(source, { window: questionWindow });
const questions = questionWindow.PEKA_QUESTION_BANK;
if (!Array.isArray(questions) || questions.length !== 15 || answerKeys.length !== 15 ||
    questions.some((item) => typeof item.question !== "string" || !item.question.trim() ||
      !Array.isArray(item.options) || item.options.length !== 4 ||
      item.options.some((option) => typeof option !== "string" || !option.trim()))) {
  throw new Error("Expected exactly 15 questions with four non-empty options each.");
}

const existingResponse = await fetch(
  `${supabaseUrl}/rest/v1/peka_questions?select=id,question_order&order=id.asc`,
  { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } },
);
if (!existingResponse.ok) throw new Error(`Question lookup failed (${existingResponse.status}): ${await existingResponse.text()}`);
const existing = await existingResponse.json();
if (!Array.isArray(existing)) throw new Error("Question lookup returned an invalid response; no rows changed.");
for (const row of existing) {
  const validLegacy = row.id >= 1 && row.id <= 30 && row.question_order === row.id + 15;
  const validCurrent = row.id >= 31 && row.id <= 45 && row.question_order === row.id - 30;
  if (!Number.isInteger(row.id) || !Number.isInteger(row.question_order) || !(validLegacy || validCurrent)) {
    throw new Error("Run migration 202611060001_peka_15_question_bank.sql before seeding; no rows changed.");
  }
}

const rows = questions.map((question, index) => ({
  id: index + 31,
  question_order: index + 1,
  question_text: question.question,
  options: question.options,
  timer_seconds: 60,
  is_active: true,
  answer_key: answerKeys[index],
  answer_key_verified: true,
}));
const response = await fetch(`${supabaseUrl}/rest/v1/peka_questions?on_conflict=id`, {
  method: "POST",
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal",
  },
  body: JSON.stringify(rows),
});
if (!response.ok) throw new Error(`Question seeding failed (${response.status}): ${await response.text()}`);

const archiveResponse = await fetch(`${supabaseUrl}/rest/v1/peka_questions?id=lte.30`, {
  method: "PATCH",
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  },
  body: JSON.stringify({ is_active: false }),
});
if (!archiveResponse.ok) throw new Error(`Legacy question archival failed (${archiveResponse.status}): ${await archiveResponse.text()}`);
console.log(`Synchronized 15 active PeKA questions; retained 30 legacy question records for historical sessions.`);
