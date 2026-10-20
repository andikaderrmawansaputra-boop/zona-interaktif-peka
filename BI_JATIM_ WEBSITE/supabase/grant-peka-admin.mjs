import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const usage = `Usage:
  node supabase/grant-peka-admin.mjs --email <verified-email> --user-id <auth-user-uuid>
  node supabase/grant-peka-admin.mjs --email <verified-email> --user-id <auth-user-uuid> --apply

Preview is the default. --apply prompts for the exact email before changing app_metadata.
Required environment: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
`;

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (argument === "--apply") {
      if (values.has(argument)) throw new Error("Duplicate --apply argument.");
      values.set(argument, true);
      continue;
    }
    if (argument !== "--email" && argument !== "--user-id") {
      throw new Error(`Unknown argument: ${argument}\n${usage}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) {
      throw new Error(`Missing or duplicate value for ${argument}.\n${usage}`);
    }
    values.set(argument, value);
    index += 1;
  }
  return values;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

async function requestUsers(url, serviceRoleKey, page) {
  const endpoint = new URL("/auth/v1/admin/users", url);
  endpoint.searchParams.set("page", String(page));
  endpoint.searchParams.set("per_page", "1000");
  const response = await fetch(endpoint, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  });
  if (!response.ok) {
    throw new Error(
      `Supabase Auth user lookup failed (HTTP ${response.status}). ` +
      "Response details were omitted; check the project URL and local service-role credentials."
    );
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.users)) {
    throw new Error("Supabase Auth returned an unexpected user-list response.");
  }
  return body.users;
}

async function findTargetUser(url, serviceRoleKey, email, expectedUserId) {
  const matches = [];
  const pageSize = 1000;
  for (let page = 1; page <= 100; page += 1) {
    const users = await requestUsers(url, serviceRoleKey, page);
    matches.push(...users.filter((user) =>
      typeof user.email === "string" &&
      normalizeEmail(user.email) === normalizeEmail(email)
    ));
    if (users.length < pageSize) break;
    if (page === 100) {
      throw new Error("User listing exceeded the safety limit; no account was changed.");
    }
  }

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Auth account matching the specified email; found ${matches.length}. ` +
      "No account was changed."
    );
  }
  const [user] = matches;
  if (user.id !== expectedUserId) {
    throw new Error("The email does not belong to the specified Auth user ID. No account was changed.");
  }
  if (typeof user.email_confirmed_at !== "string" || !user.email_confirmed_at) {
    throw new Error("The target account email is not verified. No account was changed.");
  }
  if (!user.app_metadata || typeof user.app_metadata !== "object" || Array.isArray(user.app_metadata)) {
    throw new Error("The target account has invalid app_metadata. No account was changed.");
  }
  return user;
}

async function updateAdminRole(url, serviceRoleKey, user) {
  const endpoint = new URL(
    `/auth/v1/admin/users/${encodeURIComponent(user.id)}`,
    url
  );
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      app_metadata: {
        ...user.app_metadata,
        peka_admin: true
      }
    })
  });
  if (!response.ok) {
    throw new Error(
      `Supabase Auth role update failed (HTTP ${response.status}). ` +
      "Response details were omitted; check the trusted local environment."
    );
  }
}

const argumentsMap = parseArguments(process.argv.slice(2));
const email = argumentsMap.get("--email");
const expectedUserId = argumentsMap.get("--user-id");
const apply = argumentsMap.has("--apply");

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error(`Provide one valid target email with --email.\n${usage}`);
}
if (!expectedUserId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(expectedUserId)) {
  throw new Error(`Provide the target account UUID from Supabase Auth with --user-id.\n${usage}`);
}

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) ||
    !serviceRoleKey?.trim()) {
  throw new Error(
    "Set a valid SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in this trusted local shell. " +
    "The key is never printed or stored by this script."
  );
}

const user = await findTargetUser(supabaseUrl, serviceRoleKey, email, expectedUserId);
console.log(`Verified target: ${user.email} (${user.id})`);
console.log(`Email verified: yes; current peka_admin: ${user.app_metadata.peka_admin === true}`);

if (user.app_metadata.peka_admin === true) {
  console.log("No change needed; the target already has peka_admin=true.");
  process.exit(0);
}

if (!apply) {
  console.log("Preview only; no metadata was changed. Review the target, then rerun with --apply if approved.");
  process.exit(0);
}

const prompt = createInterface({ input: stdin, output: stdout });
try {
  const confirmation = await prompt.question(
    `Type the exact target email (${user.email}) to grant peka_admin: `
  );
  if (confirmation !== user.email) {
    throw new Error("Confirmation did not exactly match the verified target email. No account was changed.");
  }
} finally {
  prompt.close();
}

await updateAdminRole(supabaseUrl, serviceRoleKey, user);
const updatedUser = await findTargetUser(supabaseUrl, serviceRoleKey, email, expectedUserId);
if (updatedUser.app_metadata.peka_admin !== true) {
  throw new Error(
    "The update request completed, but verification did not find peka_admin=true. " +
    "Check Supabase Auth before retrying."
  );
}

console.log(`Verified: ${updatedUser.email} now has app_metadata.peka_admin=true.`);
