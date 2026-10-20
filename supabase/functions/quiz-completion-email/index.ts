import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-peka-dispatch-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  const dispatchSecret = Deno.env.get("PEKA_EMAIL_DISPATCH_SECRET");
  const suppliedSecret = request.headers.get("x-peka-dispatch-secret") ?? "";
  if (!dispatchSecret || !constantTimeEquals(suppliedSecret, dispatchSecret)) {
    return jsonResponse(401, { error: "dispatch_not_authorized" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("PEKA_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const sender = Deno.env.get("PEKA_EMAIL_FROM");
  if (!supabaseUrl || !serviceRoleKey || !resendApiKey || !sender) {
    console.error("Completion email configuration is incomplete.");
    return jsonResponse(503, { status: "not_configured", retryable: false });
  }

  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const sessionId = (rawPayload as Record<string, unknown>).session_id;
  if (typeof sessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    return jsonResponse(400, { error: "invalid_session_id" });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: claim, error: claimError } = await admin
    .rpc("claim_peka_completion_email", { p_session_id: sessionId });
  if (claimError || !claim) {
    console.error("Completion email claim failed.", claimError?.code);
    return jsonResponse(503, { status: "failed", retryable: true });
  }
  if (claim.status !== "sending" || claim.outbox_id === undefined) {
    return jsonResponse(200, {
      status: claim.status,
      retryable: claim.retryable === true,
      retry_after: claim.retry_after ?? null,
    });
  }

  const recipient = typeof claim.recipient === "string" ? claim.recipient : "";
  const fullName = typeof claim.full_name === "string" ? claim.full_name : "";
  const quizType = claim.quiz_type === "PRE_TEST" || claim.quiz_type === "POST_TEST"
    ? claim.quiz_type
    : null;
  const attempt = Number(claim.attempt);
  const outboxId = typeof claim.outbox_id === "string" ? claim.outbox_id : "";
  if (!quizType || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) ||
      !fullName || !outboxId || !Number.isInteger(attempt)) {
    const { error } = await admin.rpc("finish_peka_completion_email", {
      p_outbox_id: outboxId,
      p_attempt: attempt,
      p_accepted: false,
      p_error: "invalid_completion_email_data",
      p_retry_after_seconds: 600,
    });
    if (error) console.error("Invalid completion email claim could not be released.", error.code);
    return jsonResponse(500, { status: "failed", retryable: true });
  }

  const testName = quizType === "PRE_TEST" ? "PRE_TEST" : "POST_TEST";
  const safeName = escapeHtml(fullName);
  const text = `Yth. ${fullName},\n\nAnda telah menyelesaikan ${testName} Zona Interaktif PeKA Bank Indonesia Jawa Timur. Jawaban Anda telah tercatat di sistem.\n\nTerima kasih telah berpartisipasi.\nBank Indonesia Jawa Timur`;
  const html = `<p>Yth. ${safeName},</p><p>Anda telah menyelesaikan <strong>${testName}</strong> Zona Interaktif PeKA Bank Indonesia Jawa Timur.</p><p>Jawaban Anda telah tercatat di sistem.</p><p>Terima kasih telah berpartisipasi.</p><p>Bank Indonesia Jawa Timur</p>`;
  const idempotencyKey = `peka-completion/${outboxId}`;
  let accepted = false;
  let providerMessageId: string | null = null;
  let failureCode = "resend_request_failed";

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: sender,
        to: [recipient],
        subject: "Konfirmasi Penyelesaian Tes Zona Interaktif PeKA",
        text,
        html,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const responseBody = await response.json().catch(() => ({}));
    if (response.ok && typeof responseBody.id === "string") {
      accepted = true;
      providerMessageId = responseBody.id;
    } else {
      failureCode = `resend_http_${response.status}`;
    }
  } catch (error) {
    failureCode = error instanceof Error ? error.name : "resend_network_error";
  }

  const retryAfterSeconds = Math.min(600, 30 * (2 ** Math.max(0, attempt - 1)));
  const { data: updated, error: updateError } = await admin.rpc("finish_peka_completion_email", {
    p_outbox_id: outboxId,
    p_attempt: attempt,
    p_accepted: accepted,
    p_provider_message_id: providerMessageId,
    p_error: accepted ? null : failureCode,
    p_retry_after_seconds: retryAfterSeconds,
  });
  if (updateError || updated !== true) {
    console.error("Completion email status could not be recorded.", updateError?.code);
    return jsonResponse(503, { status: "failed", retryable: true });
  }

  if (!accepted) {
    console.error("Resend did not accept completion email.", failureCode);
    return jsonResponse(200, {
      status: "failed",
      retryable: attempt < 5,
      retry_after: retryAfterSeconds,
    });
  }

  return jsonResponse(200, { status: "accepted", retryable: false });
});
