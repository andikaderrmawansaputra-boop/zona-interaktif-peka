(function () {
  "use strict";

  const config = window.PEKA_SUPABASE_CONFIG || {};
  const configured = typeof config.url === "string" &&
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.url) &&
    typeof config.anonKey === "string" &&
    (/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.anonKey.trim()) ||
      /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(config.anonKey.trim()));
  const supabaseClient = configured && window.supabase?.createClient
    ? window.supabase.createClient(config.url, config.anonKey.trim())
    : null;
  const loginCard = document.getElementById("admin-login-card");
  const reportCard = document.getElementById("admin-report-card");
  const loginForm = document.getElementById("admin-login-form");
  const emailInput = document.getElementById("admin-email");
  const passwordInput = document.getElementById("admin-password");
  const status = document.getElementById("admin-status");
  const reportStatus = document.getElementById("report-status");
  const rowsElement = document.getElementById("report-rows");
  let accessToken = "";
  let verifiedEmail = "";
  let reportRows = [];
  let visibleRows = [];
  let reportPage = 1;
  let reportTotal = 0;
  let reportStats = { total: 0, pre_test: 0, post_test: 0, in_progress: 0, completed: 0 };
  let participantStatusStats = {
    participant_count: 0,
    pre_test: { completed: 0, in_progress: 0, not_started: 0 },
    post_test: { completed: 0, in_progress: 0, not_started: 0 }
  };
  const reportPageSize = 25;

  function reportDiagnostic(code) {
    console.warn(`[peka-admin] ${code}`);
  }

  if (!configured || !supabaseClient) {
    status.textContent = !window.supabase?.createClient
      ? "Pustaka autentikasi Supabase tidak dapat dimuat. Periksa koneksi, lalu muat ulang halaman."
      : config.url
        ? "Konfigurasi Supabase belum valid. Admin belum dapat login."
        : "Supabase belum dikonfigurasi. Admin tidak dapat login.";
    loginForm.querySelector("button").disabled = true;
  }

  async function loadReport() {
    reportStatus.textContent = "Memuat data sesi dan jawaban…";
    document.getElementById("refresh-report").disabled = true;
    document.getElementById("report-previous").disabled = true;
    document.getElementById("report-next").disabled = true;
    try {
      const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
      if (sessionError) {
        throw Object.assign(new Error("Sesi admin tidak dapat diperiksa. Silakan masuk kembali."), {
          diagnosticCode: "session_check_failed"
        });
      }
      if (!sessionData.session) {
        throw Object.assign(new Error("Sesi admin berakhir. Silakan masuk kembali."), {
          diagnosticCode: "session_missing"
        });
      }
      accessToken = sessionData.session.access_token;
      verifiedEmail = sessionData.session.user.email || "";
      const response = await fetch(`${config.url}/functions/v1/quiz-admin-report`, {
        method: "POST",
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          quiz_type: document.getElementById("report-test-type").value || null,
          page: reportPage,
          page_size: reportPageSize,
          search: document.getElementById("report-search").value.trim(),
          institution: document.getElementById("report-institution").value.trim()
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 403 && data.error === "admin_access_required") {
          throw Object.assign(
            new Error("Login berhasil, tetapi akun ini belum diberi peran admin PeKA. Hubungi administrator Supabase."),
            { diagnosticCode: "admin_role_denied" }
          );
        }
        if (response.status === 401 && data.error === "verified_email_required") {
          throw Object.assign(
            new Error("Email akun admin belum terverifikasi. Verifikasi email melalui Supabase sebelum mengakses laporan."),
            { diagnosticCode: "admin_email_unverified" }
          );
        }
        if (response.status === 401) {
          throw Object.assign(
            new Error("Sesi admin tidak diterima server. Silakan masuk kembali."),
            { diagnosticCode: "report_session_rejected" }
          );
        }
        const messages = {
          invalid_search: "Pencarian hanya dapat berisi huruf, angka, spasi, @, titik, garis bawah, apostrof, dan tanda hubung.",
          invalid_institution_filter: "Filter lembaga berisi karakter yang tidak didukung.",
          search_too_broad: "Hasil pencarian terlalu banyak. Persempit nama, email, atau lembaga.",
          session_report_failed: "Data sesi gagal dimuat. Periksa log Edge Function quiz-admin-report.",
          session_statistics_failed: "Statistik laporan gagal dimuat. Periksa log Edge Function quiz-admin-report.",
          participant_report_failed: "Data peserta atau jawaban gagal dimuat. Periksa tabel dan log Edge Function quiz-admin-report.",
          question_report_failed: "Informasi soal untuk laporan gagal dimuat. Periksa tabel soal dan log Edge Function quiz-admin-report."
        };
        throw Object.assign(
          new Error(messages[data.error] || "Rekap gagal dimuat. Periksa deployment dan konfigurasi Supabase."),
          { diagnosticCode: "report_request_rejected", httpStatus: response.status }
        );
      }
      reportRows = Array.isArray(data.sessions) ? data.sessions : [];
      reportTotal = Number.isInteger(data.total) ? data.total : reportRows.length;
      reportStats = data.stats || reportStats;
      participantStatusStats = data.participant_status || participantStatusStats;
      renderStats();
      renderReport();
      const pageCount = Math.max(1, Math.ceil(reportTotal / reportPageSize));
      reportStatus.textContent = `${data.returned} sesi pada halaman ini dari ${reportTotal} sesi yang cocok. ` +
        (data.scoring_enabled
          ? "Kunci dari tabel dokumen tersedia; nilai final hanya tersedia untuk tes yang selesai."
          : data.scoring_reason === "answer_keys_unverified"
            ? "Penilaian belum aktif karena kunci seluruh soal belum terverifikasi."
            : data.scoring_reason === "no_matching_sessions"
              ? "Tidak ada sesi yang cocok dengan filter."
              : "Penilaian tidak tersedia sampai bank soal aktif lengkap dan berurutan.");
      if (typeof data.answer_key_note === "string") {
        reportStatus.textContent += ` ${data.answer_key_note}`;
      }
      document.getElementById("report-page-status").textContent =
        `Halaman ${reportPage} dari ${pageCount}`;
      document.getElementById("report-previous").disabled = reportPage <= 1;
      document.getElementById("report-next").disabled = reportPage >= pageCount;
      document.getElementById("export-report").disabled = visibleRows.length === 0;
      if (data.completion_email_status_available === false) {
        reportStatus.textContent += " Status email konfirmasi tidak dapat dimuat; data sesi, peserta, dan jawaban tetap ditampilkan.";
        reportDiagnostic("completion_email_status_unavailable");
      }
    } catch (error) {
      reportRows = [];
      reportTotal = 0;
      reportStats = { total: 0, pre_test: 0, post_test: 0, in_progress: 0, completed: 0 };
      participantStatusStats = {
        participant_count: 0,
        pre_test: { completed: 0, in_progress: 0, not_started: 0 },
        post_test: { completed: 0, in_progress: 0, not_started: 0 }
      };
      renderStats();
      renderReport();
      document.getElementById("report-page-status").textContent = "Halaman —";
      document.getElementById("report-previous").disabled = true;
      document.getElementById("report-next").disabled = true;
      reportStatus.textContent = error.message;
      reportDiagnostic(error.diagnosticCode || "report_request_failed");
      if (error.httpStatus) {
        console.warn(`[peka-admin] report_http_status_${error.httpStatus}`);
      }
      if (error.diagnosticCode === "session_missing" ||
          error.diagnosticCode === "report_session_rejected") {
        await signOut(error.message);
      }
    } finally {
      document.getElementById("refresh-report").disabled = false;
    }
  }

  function renderStats() {
    document.getElementById("stat-total").textContent = String(reportStats.total);
    document.getElementById("stat-pre-test").textContent = String(reportStats.pre_test);
    document.getElementById("stat-post-test").textContent = String(reportStats.post_test);
    document.getElementById("stat-in-progress").textContent = String(reportStats.in_progress);
    document.getElementById("stat-completed").textContent = String(reportStats.completed);
    for (const testType of ["pre_test", "post_test"]) {
      const stats = participantStatusStats[testType];
      const testTypeId = testType.replace("_", "-");
      document.getElementById(`${testTypeId}-completed`).textContent = String(stats.completed);
      document.getElementById(`${testTypeId}-in-progress`).textContent = String(stats.in_progress);
      document.getElementById(`${testTypeId}-not-started`).textContent = String(stats.not_started);
      document.getElementById(`${testTypeId}-participant-stats`).classList.toggle(
        "zona-hidden",
        document.getElementById("report-test-type").value !== "" &&
          document.getElementById("report-test-type").value !== testType.toUpperCase()
      );
    }
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    let seconds = Math.floor(milliseconds / 1000);
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;
    const parts = [];
    if (days) parts.push(`${days} hari`);
    if (hours || days) parts.push(`${hours} jam`);
    parts.push(`${minutes} menit`, `${seconds} detik`);
    return parts.join(" ");
  }

  function updateElapsedDurations() {
    const now = Date.now();
    document.querySelectorAll("[data-live-duration='true']").forEach((element) => {
      const startedAt = Number(element.dataset.startedAt);
      element.textContent = `Sedang mengerjakan · ${formatDuration(now - startedAt)}`;
    });
  }

  function emailStatusLabel(status, sessionStatus) {
    const labels = {
      pending: "Dalam antrean (belum terkirim)",
      sending: "Sedang diproses",
      accepted: "Permintaan diterima penyedia",
      failed: "Gagal",
      not_queued: "Belum diantrekan",
      unavailable: "Status tidak dapat dimuat"
    };
    return labels[status] || (sessionStatus === "completed" ? "Belum diketahui" : "—");
  }

  function renderReport() {
    rowsElement.replaceChildren();
    visibleRows = reportRows;
    const completed = visibleRows.filter((session) => session.status === "completed").length;
    document.getElementById("report-summary").textContent =
      `${reportTotal} sesi cocok · ${completed} selesai di halaman ini · ${visibleRows.length - completed} berlangsung di halaman ini`;
    document.getElementById("export-report").disabled = visibleRows.length === 0;
    if (visibleRows.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 10;
      cell.className = "zona-admin-empty";
      cell.textContent = "Belum ada sesi untuk filter ini.";
      row.appendChild(cell);
      rowsElement.appendChild(row);
      return;
    }

    visibleRows.forEach((session) => {
      const row = document.createElement("tr");
      const participant = session.participant || {};
      const startedAt = Date.parse(session.started_at);
      const started = Number.isFinite(startedAt) ? new Date(startedAt).toLocaleString("id-ID") : "—";
      const completedAt = session.completed_at ? Date.parse(session.completed_at) : null;
      const completed = completedAt !== null && Number.isFinite(completedAt)
        ? new Date(completedAt).toLocaleString("id-ID")
        : "—";
      const values = [
        participant.full_name || "—",
        participant.email || "—",
        participant.institution || "—",
        session.quiz_type === "PRE_TEST" ? "Pre-test" : "Post-test",
        session.status === "completed" ? "Selesai" : "Sedang mengerjakan"
      ];
      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });
      const timeCell = document.createElement("td");
      timeCell.className = "zona-admin-session-time";
      const startedLine = document.createElement("div");
      startedLine.textContent = `Mulai: ${started}`;
      timeCell.appendChild(startedLine);
      const completedLine = document.createElement("div");
      completedLine.textContent = `Selesai: ${completed}`;
      timeCell.appendChild(completedLine);
      const durationLine = document.createElement("div");
      if (session.status === "completed") {
        durationLine.textContent = `Durasi: ${completedAt === null ? "—" : formatDuration(completedAt - startedAt)}`;
      } else {
        durationLine.dataset.liveDuration = "true";
        durationLine.dataset.startedAt = String(startedAt);
      }
      timeCell.appendChild(durationLine);
      row.appendChild(timeCell);
      const progressCell = document.createElement("td");
      const answeredQuestions = session.status === "completed"
        ? 30
        : Math.max(0, Math.min(30, Number(session.current_question_order) - 1));
      progressCell.textContent = `${answeredQuestions} / 30`;
      row.appendChild(progressCell);
      const emailCell = document.createElement("td");
      emailCell.textContent = emailStatusLabel(session.completion_email_status, session.status);
      row.appendChild(emailCell);
      const answerCell = document.createElement("td");
      const list = document.createElement("ol");
      list.className = "zona-admin-answer-list";
      (session.answers || []).forEach((answer) => {
        const item = document.createElement("li");
        const question = document.createElement("strong");
        question.textContent = `Soal ${answer.question_order}: ${answer.question_text} `;
        item.appendChild(question);
        const response = document.createElement("span");
        response.textContent = answer.timed_out
          ? "Tidak dijawab (waktu habis)"
          : `${["A", "B", "C", "D"][answer.selected_option]}. ${answer.selected_text || "Pilihan tersimpan"}`;
        if (answer.is_correct === true) response.textContent += " · benar";
        if (answer.is_correct === false) response.textContent += " · salah";
        item.appendChild(response);
        list.appendChild(item);
      });
      answerCell.appendChild(list);
      row.appendChild(answerCell);
      const scoringCell = document.createElement("td");
      if (!session.scoring?.enabled) {
        scoringCell.textContent = session.scoring?.reason === "answer_keys_unverified"
          ? "Tidak aktif: kunci jawaban belum seluruhnya diverifikasi."
          : "Tidak tersedia: bank soal belum lengkap dan berurutan.";
      } else {
        const score = session.scoring.score === null
          ? "Nilai final belum tersedia."
          : `Nilai ${session.scoring.score}`;
        scoringCell.textContent =
          `Benar ${session.scoring.correct} · Salah ${session.scoring.incorrect} · ` +
          `Tidak dijawab ${session.scoring.unanswered} · ${score}`;
      }
      row.appendChild(scoringCell);
      rowsElement.appendChild(row);
    });
  }

  function csvCell(value) {
    const text = String(value ?? "");
    const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  function exportReport() {
    const lines = [["Nama", "Email", "Lembaga", "Jenis Tes", "Status", "Mulai", "Selesai", "Durasi", "Progres", "Status Email Konfirmasi", "Benar", "Salah", "Tidak Dijawab", "Nilai", "No. Soal", "Soal", "Jawaban", "Waktu Habis"]];
    visibleRows.forEach((session) => {
      const participant = session.participant || {};
      const answers = session.answers?.length ? session.answers : [null];
      answers.forEach((answer) => lines.push([
        participant.full_name,
        participant.email,
        participant.institution,
        session.quiz_type,
        session.status,
        session.started_at,
        session.completed_at,
        session.status === "completed"
          ? formatDuration(Date.parse(session.completed_at) - Date.parse(session.started_at))
          : `Sedang mengerjakan · ${formatDuration(Date.now() - Date.parse(session.started_at))}`,
        session.status === "completed" ? "30/30" : `${Math.max(0, Number(session.current_question_order) - 1)}/30`,
        emailStatusLabel(session.completion_email_status, session.status),
        session.scoring?.correct,
        session.scoring?.incorrect,
        session.scoring?.unanswered,
        session.scoring?.score,
        answer?.question_order,
        answer?.question_text,
        answer ? (answer.timed_out ? "" : answer.selected_text) : "",
        answer?.timed_out ? "Ya" : "Tidak"
      ]));
    });
    const csv = `\uFEFF${lines.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "rekap-zona-peka.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function signOut(message = "") {
    if (supabaseClient) {
      const { error } = await supabaseClient.auth.signOut({ scope: "local" });
      if (error) console.error("Admin sign-out failed.", error.name);
    }
    accessToken = "";
    verifiedEmail = "";
    reportRows = [];
    loginCard.classList.remove("zona-hidden");
    reportCard.classList.add("zona-hidden");
    loginForm.reset();
    rowsElement.replaceChildren();
    status.textContent = message;
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supabaseClient) return;
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    status.textContent = "Memverifikasi akun admin…";
    loginForm.querySelector("button").disabled = true;
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) {
        reportDiagnostic("authentication_failed");
        status.textContent = "Login gagal. Periksa email dan password admin.";
        return;
      }
      if (!data.session || !data.user || !data.session.access_token) {
        reportDiagnostic("session_missing_after_authentication");
        status.textContent = "Autentikasi tidak menghasilkan sesi admin. Silakan coba kembali.";
        return;
      }
      accessToken = data.session.access_token;
      verifiedEmail = data.user.email || email;
      passwordInput.value = "";
      status.textContent = "";
      loginCard.classList.add("zona-hidden");
      reportCard.classList.remove("zona-hidden");
      document.getElementById("admin-account").textContent = verifiedEmail;
      await loadReport();
    } catch (error) {
      reportDiagnostic("authentication_request_failed");
      status.textContent = "Login admin gagal karena layanan autentikasi tidak dapat dijangkau. Coba kembali.";
    } finally {
      loginForm.querySelector("button").disabled = false;
    }
  });

  document.getElementById("refresh-report").addEventListener("click", () => {
    reportPage = 1;
    loadReport();
  });
  document.getElementById("report-test-type").addEventListener("change", () => {
    reportPage = 1;
    loadReport();
  });
  document.getElementById("report-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      reportPage = 1;
      loadReport();
    }
  });
  document.getElementById("report-institution").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      reportPage = 1;
      loadReport();
    }
  });
  document.getElementById("report-previous").addEventListener("click", () => {
    if (reportPage <= 1) return;
    reportPage -= 1;
    loadReport();
  });
  document.getElementById("report-next").addEventListener("click", () => {
    if (reportPage * reportPageSize >= reportTotal) return;
    reportPage += 1;
    loadReport();
  });
  document.getElementById("export-report").addEventListener("click", exportReport);
  document.getElementById("admin-signout").addEventListener("click", () => signOut());
  window.setInterval(updateElapsedDurations, 1000);

  async function restoreAdminSession() {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) {
      reportDiagnostic("session_restore_failed");
      status.textContent = "Sesi admin tidak dapat diperiksa. Silakan masuk kembali.";
      return;
    }
    if (!data.session) return;
    if (!data.session.access_token || !data.session.user) {
      reportDiagnostic("session_missing");
      status.textContent = "Sesi admin tidak lengkap. Silakan masuk kembali.";
      return;
    }
    accessToken = data.session.access_token;
    verifiedEmail = data.session.user.email || "";
    loginCard.classList.add("zona-hidden");
    reportCard.classList.remove("zona-hidden");
    document.getElementById("admin-account").textContent = verifiedEmail;
    await loadReport();
  }

  restoreAdminSession();
})();
