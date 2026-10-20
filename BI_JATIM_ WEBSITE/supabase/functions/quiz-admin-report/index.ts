import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("PEKA_SERVICE_ROLE_KEY");
  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing SUPABASE_URL or PEKA_SERVICE_ROLE_KEY Edge Function secret.");
    return jsonResponse(503, { error: "admin_service_not_configured" });
  }
  if (!token) return jsonResponse(401, { error: "authentication_required" });

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user?.email_confirmed_at) {
    return jsonResponse(401, { error: "verified_email_required" });
  }
  if (authData.user.app_metadata?.peka_admin !== true) {
    return jsonResponse(403, { error: "admin_access_required" });
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
  const payload = rawPayload as Record<string, unknown>;

  const quizType = payload.quiz_type ?? null;
  if (quizType !== null && quizType !== "PRE_TEST" && quizType !== "POST_TEST") {
    return jsonResponse(400, { error: "invalid_quiz_type" });
  }

  const page = payload.page === undefined ? 1 : payload.page;
  const pageSize = payload.page_size === undefined ? 25 : payload.page_size;
  const search = payload.search === undefined ? "" : payload.search;
  const institution = payload.institution === undefined ? "" : payload.institution;
  if (!Number.isInteger(page) || (page as number) < 1 ||
      !Number.isInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > 100) {
    return jsonResponse(400, { error: "invalid_pagination" });
  }
  if (typeof search !== "string" || search.length > 120 ||
      !/^[\p{L}\p{M}\p{N} @._+'-]*$/u.test(search)) {
    return jsonResponse(400, { error: "invalid_search" });
  }
  if (typeof institution !== "string" || institution.length > 160 ||
      !/^[\p{L}\p{M}\p{N} @._+'-]*$/u.test(institution)) {
    return jsonResponse(400, { error: "invalid_institution_filter" });
  }

  let filteredParticipantIds: string[] | null = null;
  if (search.trim() || institution.trim()) {
    const matchedIds: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      let participantQuery = admin
        .from("peka_participants")
        .select("id")
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (search.trim()) {
        const pattern = `%${search.trim().replace(/_/g, "\\_")}%`;
        participantQuery = participantQuery.or(
          `full_name.ilike."${pattern}",email.ilike."${pattern}",institution.ilike."${pattern}"`
        );
      }
      if (institution.trim()) {
        const pattern = `%${institution.trim().replace(/_/g, "\\_")}%`;
        participantQuery = participantQuery.ilike("institution", pattern);
      }
      const result = await participantQuery;
      if (result.error) {
        console.error("Admin participant search failed.", result.error.code);
        return jsonResponse(500, { error: "participant_search_failed" });
      }
      matchedIds.push(...(result.data ?? []).map((participant) => participant.id));
      if (matchedIds.length > 500) {
        return jsonResponse(413, { error: "search_too_broad" });
      }
      if ((result.data ?? []).length < 1000) break;
    }
    filteredParticipantIds = matchedIds;
  }

  let sessionQuery = admin
    .from("peka_quiz_sessions")
    .select("id,participant_id,quiz_type,status,current_question_order,started_at,completed_at", { count: "exact" })
    .order("started_at", { ascending: false })
    .range(((page as number) - 1) * (pageSize as number),
      (page as number) * (pageSize as number) - 1);
  if (quizType) sessionQuery = sessionQuery.eq("quiz_type", quizType);
  if (filteredParticipantIds !== null) {
    if (filteredParticipantIds.length === 0) {
      return jsonResponse(200, {
        sessions: [],
        returned: 0,
        total: 0,
        page,
        page_size: pageSize,
        stats: {
          total: 0,
          pre_test: 0,
          post_test: 0,
          in_progress: 0,
          completed: 0,
        },
        participant_status: {
          participant_count: 0,
          pre_test: { completed: 0, in_progress: 0, not_started: 0 },
          post_test: { completed: 0, in_progress: 0, not_started: 0 },
        },
        scoring_enabled: false,
        scoring_reason: "no_matching_sessions",
      });
    }
    sessionQuery = sessionQuery.in("participant_id", filteredParticipantIds);
  }
  const { data: sessions, error: sessionsError, count } = await sessionQuery;
  if (sessionsError) {
    console.error("Admin session report failed.", sessionsError.code);
    return jsonResponse(500, { error: "session_report_failed" });
  }

  const countSessions = async (
    type: "PRE_TEST" | "POST_TEST" | null,
    status: "in_progress" | "completed" | null,
  ) => {
    if (type && quizType && type !== quizType) {
      return { count: 0, error: null };
    }
    let query = admin
      .from("peka_quiz_sessions")
      .select("id", { count: "exact", head: true });
    if (type) query = query.eq("quiz_type", type);
    if (status) query = query.eq("status", status);
    if (filteredParticipantIds !== null) {
      query = query.in("participant_id", filteredParticipantIds);
    }
    return await query;
  };
  const [preTestStats, postTestStats, inProgressStats, completedStats] = await Promise.all([
    quizType === "POST_TEST" ? Promise.resolve({ count: 0, error: null }) : countSessions("PRE_TEST", null),
    quizType === "PRE_TEST" ? Promise.resolve({ count: 0, error: null }) : countSessions("POST_TEST", null),
    countSessions(quizType, "in_progress"),
    countSessions(quizType, "completed"),
  ]);
  if (preTestStats.error || postTestStats.error || inProgressStats.error || completedStats.error) {
    console.error("Admin session statistics failed.",
      preTestStats.error?.code,
      postTestStats.error?.code,
      inProgressStats.error?.code,
      completedStats.error?.code);
    return jsonResponse(500, { error: "session_statistics_failed" });
  }

  const countTestStatus = (
    type: "PRE_TEST" | "POST_TEST",
    status: "in_progress" | "completed",
  ) => {
    let query = admin
      .from("peka_quiz_sessions")
      .select("id", { count: "exact", head: true })
      .eq("quiz_type", type)
      .eq("status", status);
    if (filteredParticipantIds !== null) {
      query = query.in("participant_id", filteredParticipantIds);
    }
    return query;
  };
  const participantCountQuery = filteredParticipantIds === null
    ? admin.from("peka_participants").select("id", { count: "exact", head: true })
    : Promise.resolve({ count: filteredParticipantIds.length, error: null });
  const [
    participantCountResult,
    preTestCompletedResult,
    preTestInProgressResult,
    postTestCompletedResult,
    postTestInProgressResult,
  ] = await Promise.all([
    participantCountQuery,
    countTestStatus("PRE_TEST", "completed"),
    countTestStatus("PRE_TEST", "in_progress"),
    countTestStatus("POST_TEST", "completed"),
    countTestStatus("POST_TEST", "in_progress"),
  ]);
  if (participantCountResult.error || preTestCompletedResult.error ||
      preTestInProgressResult.error || postTestCompletedResult.error ||
      postTestInProgressResult.error) {
    console.error("Admin participant status statistics failed.",
      participantCountResult.error?.code,
      preTestCompletedResult.error?.code,
      preTestInProgressResult.error?.code,
      postTestCompletedResult.error?.code,
      postTestInProgressResult.error?.code);
    return jsonResponse(500, { error: "session_statistics_failed" });
  }
  const participantCount = participantCountResult.count ?? 0;
  const preTestCompleted = preTestCompletedResult.count ?? 0;
  const preTestInProgress = preTestInProgressResult.count ?? 0;
  const postTestCompleted = postTestCompletedResult.count ?? 0;
  const postTestInProgress = postTestInProgressResult.count ?? 0;

  const sessionRows = sessions ?? [];
  const sessionParticipantIds = [...new Set(sessionRows.map((row) => row.participant_id))];
  const sessionIds = sessionRows.map((row) => row.id);
  const [participantsResult, answersResult] = await Promise.all([
    sessionParticipantIds.length
      ? admin.from("peka_participants")
          .select("id,full_name,email,institution")
          .in("id", sessionParticipantIds)
      : Promise.resolve({ data: [], error: null }),
    (async () => {
      const allAnswers = [];
      for (let offset = 0; sessionIds.length; offset += 1000) {
        const page = await admin
          .from("peka_answers")
          .select("session_id,question_id,selected_option,timed_out,answered_at")
          .in("session_id", sessionIds)
          .order("question_id", { ascending: true })
          .range(offset, offset + 999);
        if (page.error) return { data: null, error: page.error };
        allAnswers.push(...(page.data ?? []));
        if ((page.data ?? []).length < 1000) break;
      }
      return { data: allAnswers, error: null };
    })(),
  ]);

  if (participantsResult.error || answersResult.error) {
    console.error("Admin participant/answer report failed.",
      participantsResult.error?.code, answersResult.error?.code);
    return jsonResponse(500, { error: "participant_report_failed" });
  }

  const completionEmailStatus = new Map<string, string>();
  let completionEmailStatusAvailable = true;
  if (sessionIds.length) {
    try {
      const completionEmailsResult = await admin
        .from("peka_completion_emails")
        .select("session_id,status")
        .in("session_id", sessionIds);
      if (completionEmailsResult.error) {
        completionEmailStatusAvailable = false;
        console.error("Admin completion email status lookup failed.", completionEmailsResult.error.code);
      } else {
        for (const row of completionEmailsResult.data ?? []) {
          completionEmailStatus.set(row.session_id, row.status);
        }
      }
    } catch {
      completionEmailStatusAvailable = false;
      console.error("Admin completion email status lookup failed.");
    }
  }

  const questionsResult = await admin
    .from("peka_questions")
    .select("id,question_order,question_text,options,answer_key,answer_key_verified")
    .eq("is_active", true)
    .order("question_order", { ascending: true });
  if (questionsResult.error) {
    console.error("Admin question lookup failed.", questionsResult.error.code);
    return jsonResponse(500, { error: "question_report_failed" });
  }

  const participants = new Map((participantsResult.data ?? []).map((row) => [row.id, row]));
  const questionById = new Map((questionsResult.data ?? []).map((row) => [row.id, row]));
  const questionBankComplete = (questionsResult.data ?? []).length === 30 &&
    (questionsResult.data ?? []).every((question, index) =>
      question.question_order === index + 1
    );
  const scoringEnabled = questionBankComplete &&
    (questionsResult.data ?? []).every((question) =>
      question.answer_key_verified === true &&
      Number.isInteger(question.answer_key) &&
      question.answer_key >= 0 &&
      question.answer_key <= 3
    );
  const scoringReason = scoringEnabled
    ? "ready"
    : questionBankComplete
      ? "answer_keys_unverified"
      : "question_bank_incomplete";
  const answersBySession = new Map<string, Array<Record<string, unknown>>>();
  for (const answer of answersResult.data ?? []) {
    const question = questionById.get(answer.question_id);
    const selectedOption = answer.selected_option === null
      ? null
      : question?.options?.[answer.selected_option] ?? null;
    const entry = {
      question_order: question?.question_order ?? answer.question_id,
      question_text: question?.question_text ?? "",
      selected_option: answer.selected_option,
      selected_text: selectedOption,
      timed_out: answer.timed_out,
      answered_at: answer.answered_at,
      is_correct: question?.answer_key_verified === true &&
        answer.selected_option !== null
        ? answer.selected_option === question.answer_key
        : null,
    };
    const list = answersBySession.get(answer.session_id) ?? [];
    list.push(entry);
    answersBySession.set(answer.session_id, list);
  }

  const report = sessionRows.map((session) => {
    const answers = answersBySession.get(session.id) ?? [];
    const correct = answers.filter((answer) => answer.is_correct === true).length;
    const incorrect = answers.filter((answer) => answer.is_correct === false).length;
    const unanswered = answers.filter((answer) =>
      answer.timed_out === true || answer.selected_option === null
    ).length;
    const completeAnswerSet = answers.length === 30 &&
      new Set(answers.map((answer) => answer.question_order)).size === 30 &&
      answers.every((answer) =>
        Number.isInteger(answer.question_order) &&
        answer.question_order >= 1 &&
        answer.question_order <= 30
      );
    const isFinalScore = scoringEnabled &&
      session.status === "completed" &&
      completeAnswerSet;
    return {
      ...session,
      participant: participants.get(session.participant_id) ?? null,
      completion_email_status: completionEmailStatus.get(session.id) ??
        (completionEmailStatusAvailable ? "not_queued" : "unavailable"),
      answers,
      scoring: {
        enabled: scoringEnabled,
        reason: scoringReason,
        final: isFinalScore,
        correct: scoringEnabled ? correct : null,
        incorrect: scoringEnabled ? incorrect : null,
        unanswered: scoringEnabled ? unanswered : null,
        score: isFinalScore ? Number(((correct / 30) * 100).toFixed(2)) : null,
      },
    };
  });
  return jsonResponse(200, {
    sessions: report,
    returned: report.length,
    total: count ?? 0,
    stats: {
      total: count ?? 0,
      pre_test: preTestStats.count ?? 0,
      post_test: postTestStats.count ?? 0,
      in_progress: inProgressStats.count ?? 0,
      completed: completedStats.count ?? 0,
    },
    participant_status: {
      participant_count: participantCount,
      pre_test: {
        completed: preTestCompleted,
        in_progress: preTestInProgress,
        not_started: Math.max(0, participantCount - preTestCompleted - preTestInProgress),
      },
      post_test: {
        completed: postTestCompleted,
        in_progress: postTestInProgress,
        not_started: Math.max(0, participantCount - postTestCompleted - postTestInProgress),
      },
    },
    page,
    page_size: pageSize,
    completion_email_status_available: completionEmailStatusAvailable,
    scoring_enabled: scoringEnabled,
    scoring_reason: scoringReason,
    answer_key_note: "Kunci nomor 19 adalah A (phishing melalui email dan situs tiruan), sedangkan nomor 30 adalah C (jumlah saves dan shares).",
  });
});
