import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function collectSensitiveStrings(value: unknown, values: string[]): void {
  if (typeof value === "string") {
    if (value) values.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveStrings(item, values);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectSensitiveStrings(item, values);
  }
}

function sanitizeDiagnosticText(value: string, sensitiveValues: string[]): string {
  let sanitized = value.replace(
    /[A-Z0-9.!#$&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi,
    "[REDACTED]",
  );
  for (const sensitiveValue of [...new Set(sensitiveValues)].sort((a, b) => b.length - a.length)) {
    if (!sensitiveValue) continue;
    const escaped = sensitiveValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    sanitized = sanitized.replace(new RegExp(escaped, "gi"), "[REDACTED]");
  }
  return sanitized;
}

function logDatabaseError(
  operation: string,
  error: { code?: string; message?: string; details?: string | null; hint?: string | null },
  sensitiveValues: string[],
): void {
  console.error(operation, {
    code: error.code ?? null,
    message: error.message ? sanitizeDiagnosticText(error.message, sensitiveValues) : null,
    details: error.details ? sanitizeDiagnosticText(error.details, sensitiveValues) : null,
    hint: error.hint ? sanitizeDiagnosticText(error.hint, sensitiveValues) : null,
  });
}

function logUnhandledError(error: unknown, sensitiveValues: string[]): void {
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
    ? error.name
    : "UnknownError";
  let stack = error instanceof Error ? error.stack?.split("\n").slice(1).join("\n") : undefined;
  if (stack) {
    stack = sanitizeDiagnosticText(stack, sensitiveValues);
  }
  console.error("Unhandled quiz-session error.", { name: errorName, stack });
}

function validEmail(value: string): boolean {
  return value.length <= 254 &&
    /^[A-Z0-9.!#$&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(value);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function shuffledQuestionIds(): number[] {
  const questionIds = Array.from({ length: 30 }, (_, index) => index + 1);
  const randomValue = new Uint32Array(1);
  for (let index = questionIds.length - 1; index > 0; index -= 1) {
    crypto.getRandomValues(randomValue);
    const swapIndex = Math.floor((randomValue[0] / 0x100000000) * (index + 1));
    [questionIds[index], questionIds[swapIndex]] = [questionIds[swapIndex], questionIds[index]];
  }
  return questionIds;
}

async function sendCompletionEmail(
  supabaseUrl: string,
  serviceRoleKey: string,
  dispatchSecret: string | undefined,
  sessionId: string,
): Promise<{ email_status: string; email_retryable: boolean }> {
  if (!dispatchSecret) {
    return { email_status: "not_configured", email_retryable: true };
  }
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/quiz-completion-email`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        "x-peka-dispatch-secret": dispatchSecret,
      },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    if (typeof data.status !== "string") {
      console.error("Completion email function returned an error.", response.status);
      return { email_status: "failed", email_retryable: true };
    }
    if (!response.ok) {
      console.error("Completion email function returned an error.", response.status);
    }
    return {
      email_status: data.status,
      email_retryable: data.retryable === true,
    };
  } catch (error) {
    console.error(
      "Completion email request failed.",
      error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "UnknownError",
    );
    return { email_status: "failed", email_retryable: true };
  }
}

Deno.serve(async (request: Request) => {
  const sensitiveLogValues: string[] = [];
  try {
    return await handleQuizSession(request, sensitiveLogValues);
  } catch (error) {
    logUnhandledError(error, sensitiveLogValues);
    return jsonResponse(500, { error: "internal_server_error" });
  }
});

async function handleQuizSession(
  request: Request,
  sensitiveLogValues: string[],
): Promise<Response> {
  sensitiveLogValues.push(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("PEKA_SERVICE_ROLE_KEY") ?? "",
    Deno.env.get("PEKA_PUBLIC_API_KEY") ?? "",
    Deno.env.get("PEKA_EMAIL_DISPATCH_SECRET") ?? "",
    request.headers.get("apikey") ?? "",
    request.headers.get("authorization") ?? "",
  );
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("PEKA_SERVICE_ROLE_KEY");
  const expectedPublicApiKey = Deno.env.get("PEKA_PUBLIC_API_KEY");
  if (!supabaseUrl || !serviceRoleKey || !expectedPublicApiKey) {
    console.error("Missing required quiz-session Edge Function configuration.");
    return jsonResponse(503, { error: "quiz_service_not_configured" });
  }
  const suppliedApiKey = request.headers.get("apikey");
  if (!suppliedApiKey) {
    return jsonResponse(401, { error: "api_key_required" });
  }
  if (suppliedApiKey !== expectedPublicApiKey) {
    return jsonResponse(401, { error: "api_key_invalid" });
  }

  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  collectSensitiveStrings(rawPayload, sensitiveLogValues);
  if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const payload = rawPayload as Record<string, unknown>;
  const action = payload.action;
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (action === "start") {
    const fullName = typeof payload.full_name === "string"
      ? payload.full_name.trim().replace(/\s+/g, " ")
      : "";
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const institution = typeof payload.institution === "string"
      ? payload.institution.trim().replace(/\s+/g, " ")
      : "";
    const quizType = payload.quiz_type;
    sensitiveLogValues.push(fullName, email, institution);

    if (fullName.length < 2 || fullName.length > 120 ||
        !/^[\p{L}\p{M} .’'-]+$/u.test(fullName) ||
        !validEmail(email) ||
        institution.length < 2 || institution.length > 160 ||
        /[\u0000-\u001f\u007f]/.test(institution)) {
      return jsonResponse(400, { error: "invalid_identity" });
    }
    if (quizType !== "PRE_TEST" && quizType !== "POST_TEST") {
      return jsonResponse(400, { error: "invalid_quiz_type" });
    }

    const { data: activeQuestions, count: activeQuestionCount, error: questionCountError } = await admin
      .from("peka_questions")
      .select("id,question_order,options,timer_seconds,answer_key,answer_key_verified", { count: "exact" })
      .eq("is_active", true)
      .order("question_order", { ascending: true });
    const questionBankReady = activeQuestionCount === 30 &&
      activeQuestions?.length === 30 &&
      activeQuestions.every((question, index) =>
        question.id === index + 1 &&
        question.question_order === index + 1 &&
        Array.isArray(question.options) &&
        question.options.length === 4 &&
        question.timer_seconds === 60 &&
        Number.isInteger(question.answer_key) &&
        question.answer_key >= 0 &&
        question.answer_key <= 3 &&
        question.answer_key_verified === true
      );
    if (questionCountError || !questionBankReady) {
      console.error("Question bank is not ready.", questionCountError?.code);
      return jsonResponse(503, { error: "question_bank_unavailable" });
    }

    let participant = await admin
      .from("peka_participants")
      .select("id,full_name,institution")
      .eq("email", email)
      .maybeSingle();
    if (participant.error) {
      console.error("Participant lookup failed.", participant.error.code);
      return jsonResponse(500, { error: "participant_lookup_failed" });
    }
    if (participant.data &&
        (participant.data.full_name !== fullName || participant.data.institution !== institution)) {
      return jsonResponse(409, { error: "identity_mismatch" });
    }
    if (!participant.data) {
      const inserted = await admin
        .from("peka_participants")
        .insert({ auth_user_id: null, full_name: fullName, email, institution })
        .select("id,full_name,institution")
        .single();
      if (inserted.error?.code === "23505") {
        participant = await admin
          .from("peka_participants")
          .select("id,full_name,institution")
          .eq("email", email)
          .maybeSingle();
        if (participant.error || !participant.data) {
          console.error("Concurrent participant lookup failed.", participant.error?.code);
          return jsonResponse(409, { error: "participant_identity_conflict" });
        }
        if (participant.data.full_name !== fullName || participant.data.institution !== institution) {
          return jsonResponse(409, { error: "identity_mismatch" });
        }
      } else if (inserted.error || !inserted.data) {
        console.error("Participant creation failed.", inserted.error?.code);
        return jsonResponse(500, { error: "participant_creation_failed" });
      } else {
        participant = { data: inserted.data, error: null };
      }
    }
    const participantId = participant.data.id;

    const { data: existingSession, error: existingError } = await admin
      .from("peka_quiz_sessions")
      .select("id,status")
      .eq("participant_id", participantId)
      .eq("quiz_type", quizType)
      .maybeSingle();
    if (existingError) {
      console.error("Session lookup failed.", existingError.code);
      return jsonResponse(500, { error: "session_lookup_failed" });
    }
    let session = existingSession;
    if (!session) {
      const created = await admin
        .from("peka_quiz_sessions")
        .insert({
          participant_id: participantId,
          quiz_type: quizType,
          question_sequence: quizType === "POST_TEST"
            ? shuffledQuestionIds()
            : Array.from({ length: 30 }, (_, index) => index + 1),
        })
        .select("id,status")
        .single();
      if (created.error?.code === "23505") {
        const concurrent = await admin
          .from("peka_quiz_sessions")
          .select("id,status")
          .eq("participant_id", participantId)
          .eq("quiz_type", quizType)
          .maybeSingle();
        if (concurrent.data?.status === "completed") {
          return jsonResponse(409, { error: "test_already_completed" });
        }
        session = concurrent.data;
        if (!session) {
          logDatabaseError("Session creation failed with a unique conflict.", created.error, sensitiveLogValues);
          if (concurrent.error) {
            logDatabaseError("Concurrent session lookup failed.", concurrent.error, sensitiveLogValues);
          }
          return jsonResponse(500, { error: "session_creation_failed" });
        }
      } else if (created.error || !created.data) {
        if (created.error) {
          logDatabaseError("Session creation failed.", created.error, sensitiveLogValues);
        } else {
          console.error("Session creation returned no session data.", { quiz_type: quizType });
        }
        return jsonResponse(500, { error: "session_creation_failed" });
      } else {
        session = created.data;
      }
    }
    if (!session) {
      console.error("Session creation completed without a session.", { quiz_type: quizType });
      return jsonResponse(500, { error: "session_creation_failed" });
    }

    const { data: state, error: stateError } = await admin.rpc("advance_peka_quiz", {
      p_session_id: session.id,
      p_participant_id: participantId,
      p_action: "current",
      p_question_order: null,
      p_selected_option: null,
    });
    if (stateError) {
      console.error("Initial question retrieval failed.", stateError.code);
      return jsonResponse(503, { error: "question_bank_unavailable" });
    }
    if (state?.completed) {
      const email = await sendCompletionEmail(
        supabaseUrl,
        serviceRoleKey,
        Deno.env.get("PEKA_EMAIL_DISPATCH_SECRET"),
        session.id,
      );
      return jsonResponse(200, { session_id: session.id, ...state, ...email });
    }
    return jsonResponse(200, { session_id: session.id, ...state });
  }

  if (action === "current" || action === "answer" || action === "retry_email") {
    const sessionId = payload.session_id;
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!validSessionId(sessionId)) {
      return jsonResponse(400, { error: "invalid_session_id" });
    }
    if (!validEmail(email)) return jsonResponse(400, { error: "invalid_identity" });

    const { data: sessionOwner, error: ownerError } = await admin
      .from("peka_quiz_sessions")
      .select("id,participant_id,status")
      .eq("id", sessionId)
      .maybeSingle();
    if (ownerError) {
      console.error("Session owner lookup failed.", ownerError.code);
      return jsonResponse(500, { error: "session_lookup_failed" });
    }
    if (!sessionOwner) return jsonResponse(404, { error: "session_not_found" });

    const { data: participant, error: participantError } = await admin
      .from("peka_participants")
      .select("id,email")
      .eq("id", sessionOwner.participant_id)
      .single();
    if (participantError || typeof participant?.email !== "string" ||
        participant.email.toLowerCase() !== email) {
      return jsonResponse(404, { error: "session_not_found" });
    }

    if (action === "retry_email") {
      if (sessionOwner.status !== "completed") {
        return jsonResponse(409, { error: "test_not_completed" });
      }
      const { data: completedState, error: completionError } = await admin.rpc("advance_peka_quiz", {
        p_session_id: sessionId,
        p_participant_id: participant.id,
        p_action: "current",
        p_question_order: null,
        p_selected_option: null,
      });
      if (completionError || completedState?.completed !== true) {
        console.error("Completion verification failed before email retry.", completionError?.code);
        return jsonResponse(409, { error: "test_result_not_confirmed" });
      }
      const emailStatus = await sendCompletionEmail(
        supabaseUrl,
        serviceRoleKey,
        Deno.env.get("PEKA_EMAIL_DISPATCH_SECRET"),
        sessionId,
      );
      return jsonResponse(200, { completed: true, ...emailStatus });
    }

    const questionOrder = payload.question_order;
    const selectedOption = payload.selected_option;
    if (action === "answer" &&
        (!Number.isInteger(questionOrder) || questionOrder < 1 || questionOrder > 30 ||
         !(selectedOption === null || (Number.isInteger(selectedOption) && selectedOption >= 0 && selectedOption <= 3)))) {
      return jsonResponse(400, { error: "invalid_answer" });
    }

    const { data, error } = await admin.rpc("advance_peka_quiz", {
      p_session_id: sessionId,
      p_participant_id: participant.id,
      p_action: action,
      p_question_order: action === "answer" ? questionOrder : null,
      p_selected_option: action === "answer" ? selectedOption : null,
    });
    if (error) {
      if (error.code === "42501") return jsonResponse(404, { error: "session_not_found" });
      if (error.code === "40001") return jsonResponse(409, { error: "stale_question" });
      if (error.message.includes("timer_not_expired")) return jsonResponse(409, { error: "timer_not_expired" });
      if (error.code === "22023") return jsonResponse(400, { error: "invalid_answer" });
      console.error("Quiz progression failed.", error.code);
      return jsonResponse(500, { error: "quiz_progression_failed" });
    }
    if (data?.completed) {
      const emailStatus = await sendCompletionEmail(
        supabaseUrl,
        serviceRoleKey,
        Deno.env.get("PEKA_EMAIL_DISPATCH_SECRET"),
        sessionId,
      );
      return jsonResponse(200, { ...data, ...emailStatus });
    }
    return jsonResponse(200, data ?? {});
  }

  return jsonResponse(400, { error: "invalid_action" });
}
