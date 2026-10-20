import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const answerKeys = [
  1, 2, 1, 2, 1, 2, 1, 1, 2, 1,
  2, 0, 3, 2, 0, 1, 1, 0, 0, 1,
  1, 0, 1, 2, 2, 1, 2, 1, 2, 2
];

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the local shell environment.");
}

const source = await readFile(resolve(projectRoot, "zona-peka-questions.js"), "utf8");
const questionWindow = {};
runInNewContext(source, { window: questionWindow });
const questions = questionWindow.PEKA_QUESTION_BANK;

if (!Array.isArray(questions) || questions.length !== 30 ||
    questions.some((item) =>
      typeof item.question !== "string" ||
      !item.question.trim() ||
      !Array.isArray(item.options) ||
      item.options.length !== 4 ||
      item.options.some((option) => typeof option !== "string" || !option.trim())
    )) {
  throw new Error("Expected exactly 30 questions with four options each.");
}

const rows = questions.map((question, index) => ({
  id: index + 1,
  question_order: index + 1,
  question_text: question.question,
  options: question.options,
  timer_seconds: 60,
  is_active: true,
  answer_key: answerKeys[index],
  answer_key_verified: true
}));

const existingResponse = await fetch(
  `${supabaseUrl}/rest/v1/peka_questions?select=id,question_order&order=question_order.asc`,
  {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  }
);
if (!existingResponse.ok) {
  const detail = await existingResponse.text();
  throw new Error(`Existing question lookup failed (${existingResponse.status}): ${detail}`);
}
const existingRows = await existingResponse.json();
if (!Array.isArray(existingRows)) {
  throw new Error("Existing question lookup returned an invalid response; no rows were changed.");
}

const existingByOrder = new Map();
const existingIds = new Set();
for (const existing of existingRows) {
  if (!Number.isInteger(existing.id) ||
      !Number.isInteger(existing.question_order) ||
      existing.id !== existing.question_order ||
      existing.id < 1 ||
      existing.id > 30 ||
      existingIds.has(existing.id) ||
      existingByOrder.has(existing.question_order)) {
    throw new Error("Existing question IDs do not match the stable 1-30 order; no rows were changed.");
  }
  existingIds.add(existing.id);
  existingByOrder.set(existing.question_order, existing);
}

const response = await fetch(
  `${supabaseUrl}/rest/v1/peka_questions?on_conflict=id`,
  {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(rows)
  }
);

if (!response.ok) {
  const detail = await response.text();
  throw new Error(`Question seeding failed (${response.status}): ${detail}`);
}

const existingCount = existingByOrder.size;
console.log(
  `Synchronized 30 PeKA questions and answer keys (${existingCount} existing rows updated; ${30 - existingCount} missing rows inserted).`
);
