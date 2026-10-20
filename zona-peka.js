(function () {
  "use strict";

  const questions = window.PEKA_QUESTION_BANK;
  const setupPanel = document.getElementById("setup-panel");
  const quizPanel = document.getElementById("quiz-panel");
  const completePanel = document.getElementById("complete-panel");
  const form = document.getElementById("participant-form");
  const identityReview = document.getElementById("identity-review");
  const startStatus = document.getElementById("start-status");
  const completeEmailStatus = document.getElementById("complete-email-status");
  const retryEmailButton = document.getElementById("retry-completion-email");
  const timerElement = document.getElementById("timer");
  const questionText = document.getElementById("question-text");
  const questionContent = document.getElementById("question-content");
  const answerOptions = document.getElementById("answer-options");
  const questionCount = document.getElementById("question-count");
  const questionPercent = document.getElementById("question-percent");
  const progress = document.querySelector(".zona-progress");
  const progressBar = document.getElementById("progress-bar");
  const quizStatus = document.getElementById("quiz-status");
  const quizTypeLabel = document.getElementById("quiz-type-label");
  const storageModeLabel = document.getElementById("storage-mode-label");
  const storageModeMessage = document.getElementById("storage-mode-message");
  const participantDataNotice = document.getElementById("participant-data-notice");
  const errorFields = {
    name: document.getElementById("name-error"),
    email: document.getElementById("email-error"),
    institution: document.getElementById("institution-error")
  };
  const answerLetters = ["A", "B", "C", "D"];

  let currentQuestion = 0;
  let secondsLeft = 60;
  let timerId = null;
  let advanceId = null;
  let locked = false;
  const questionDurationSeconds = 60;
  const supabaseConfig = window.PEKA_SUPABASE_CONFIG || {};
  const hasSupabaseUrl = typeof supabaseConfig.url === "string" && supabaseConfig.url.trim().length > 0;
  const hasValidSupabaseUrl = hasSupabaseUrl &&
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseConfig.url);
  const hasPublicSupabaseKey = typeof supabaseConfig.anonKey === "string" &&
    (/^sb_publishable_[A-Za-z0-9_-]+$/.test(supabaseConfig.anonKey.trim()) ||
      /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(supabaseConfig.anonKey.trim()));
  const hasSupabaseConfig = hasValidSupabaseUrl && hasPublicSupabaseKey;
  let serverMode = false;
  let sessionId = "";
  let selectedQuizType = "PRE_TEST";
  let pendingIdentity = null;
  let remoteQuestion = null;
  let remoteSecondsRemaining = questionDurationSeconds;

  if (hasSupabaseConfig) {
    storageModeLabel.textContent = "Konfigurasi Supabase ditemukan:";
    storageModeMessage.textContent = "identitas dikonfirmasi oleh peserta sebelum tes; sesi dan jawaban diproses oleh server dan disimpan di Supabase.";
    participantDataNotice.textContent = "Nama, email, lembaga, jenis tes, jawaban atau timeout, dan waktu respons disimpan di Supabase untuk administrasi. Email peserta tidak diverifikasi dengan OTP. Pastikan peserta telah menerima pemberitahuan privasi dan retensi data sebelum pengumpulan.";
  } else if (hasSupabaseUrl) {
    storageModeLabel.textContent = "Konfigurasi Supabase belum lengkap:";
    storageModeMessage.textContent = hasValidSupabaseUrl
      ? "Project URL tersedia, tetapi publishable/anon key belum diisi atau formatnya tidak valid. Kuis dinonaktifkan agar tidak masuk ke mode pratinjau."
      : "Project URL tidak valid. Kuis dinonaktifkan sampai konfigurasi Supabase diperbaiki.";
    participantDataNotice.textContent = "Belum ada data peserta yang dikirim atau disimpan. Hubungi administrator untuk melengkapi konfigurasi Supabase.";
    form.querySelector('button[type="submit"]').disabled = true;
  } else {
    storageModeLabel.textContent = "Mode pratinjau:";
    storageModeMessage.textContent = "layanan penyimpanan peserta belum dikonfigurasi. Jangan gunakan data pribadi nyata. Identitas dan jawaban hanya dipakai sementara di halaman ini, tidak dikirim ke server dan tidak disimpan setelah halaman ditutup.";
    participantDataNotice.textContent = "Mode pratinjau: data identitas dan jawaban tidak dikirim ke server atau disimpan setelah halaman ditutup. Jangan gunakan data pribadi nyata.";
  }

  if (!Array.isArray(questions) || questions.length !== 30 ||
      questions.some((item) => !item.question || !Array.isArray(item.options) || item.options.length !== 4)) {
    throw new Error("Bank soal PeKA tidak lengkap atau formatnya tidak valid.");
  }

  function showPanel(panel) {
    [setupPanel, quizPanel, completePanel].forEach((element) => element.classList.add("zona-hidden"));
    panel.classList.remove("zona-hidden");
    panel.classList.remove("zona-enter");
    void panel.offsetWidth;
    panel.classList.add("zona-enter");
  }

  function clearTimers() {
    window.clearInterval(timerId);
    window.clearTimeout(advanceId);
    timerId = null;
    advanceId = null;
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  async function callQuizService(payload) {
    let response;
    try {
      response = await fetch(`${supabaseConfig.url}/functions/v1/quiz-session`, {
        method: "POST",
        headers: {
          apikey: supabaseConfig.anonKey.trim(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
    } catch {
      throw new Error("Tidak dapat terhubung ke layanan kuis. Periksa koneksi internet, lalu coba lagi.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errors = {
        test_already_completed: "Alamat email ini sudah menyelesaikan jenis tes tersebut. Setiap jenis tes hanya dapat diikuti satu kali.",
        test_already_started_or_completed: "Sesi tes untuk alamat email dan jenis ini sudah pernah dimulai.",
        identity_mismatch: "Identitas dengan email ini berbeda dari pendaftaran pertama. Gunakan nama dan lembaga yang sama, atau periksa alamat email.",
        question_bank_unavailable: "Bank soal belum disiapkan di database. Hubungi administrator.",
        invalid_identity: "Identitas peserta tidak valid. Periksa nama, email, dan lembaga.",
        session_not_found: "Sesi tidak ditemukan atau tidak cocok dengan email peserta.",
        test_not_completed: "Email konfirmasi hanya dapat dicoba setelah tes selesai.",
        test_result_not_confirmed: "Server belum dapat memastikan seluruh jawaban tersimpan. Hasil tes tidak diubah.",
        stale_question: "Respons soal sudah diterima atau sesi telah berpindah. Memuat posisi sesi terbaru.",
        timer_not_expired: "Waktu soal masih berjalan menurut server. Lanjutkan menjawab sampai waktunya habis.",
        quiz_service_not_configured: "Layanan kuis belum dikonfigurasi dengan benar. Hubungi administrator."
      };
      if (response.status === 401) {
        if (data.error === "api_key_required") {
          throw new Error("Kunci publik layanan kuis tidak terkirim. Muat ulang halaman atau hubungi administrator.");
        }
        if (data.error === "api_key_invalid") {
          throw new Error("Kunci publik tidak cocok dengan konfigurasi layanan kuis. Hubungi administrator.");
        }
        throw new Error("Gateway Supabase menolak request sebelum fungsi kuis berjalan. Administrator perlu memeriksa key proyek dan Verify JWT pada deployment fungsi.");
      }
      if (response.status === 403) {
        throw new Error("Akses ke fungsi kuis ditolak. Administrator perlu memeriksa konfigurasi autentikasi dan deployment fungsi.");
      }
      if (response.status === 404) {
        throw new Error("Fungsi kuis tidak ditemukan di project Supabase ini. Administrator perlu memeriksa deployment dan URL project.");
      }
      if (response.status >= 500) {
        throw new Error(errors[data.error] ||
          "Layanan kuis mengalami gangguan atau belum terkonfigurasi. Coba lagi nanti atau hubungi administrator.");
      }
      throw new Error(errors[data.error] || "Layanan kuis tidak dapat memproses permintaan. Coba lagi.");
    }
    return data;
  }

  function validateParticipant() {
    const fields = {
      name: document.getElementById("participant-name"),
      email: document.getElementById("participant-email"),
      institution: document.getElementById("participant-institution")
    };
    const messages = {
      name: "Nama lengkap wajib diisi (2–120 karakter).",
      email: "Masukkan alamat email dengan format yang benar.",
      institution: "Lembaga/instansi wajib diisi (2–160 karakter)."
    };
    let valid = true;

    Object.keys(fields).forEach((key) => {
      const field = fields[key];
      const normalized = field.value.trim().replace(/\s+/g, " ");
      field.value = normalized;
      const validCharacters = key === "name"
        ? /^[\p{L}\p{M} .’'-]+$/u.test(normalized)
        : !/[\u0000-\u001f\u007f]/.test(normalized);
      const fieldValid = field.checkValidity() && normalized.length >= 2 && validCharacters;
      field.setAttribute("aria-invalid", String(!fieldValid));
      errorFields[key].textContent = fieldValid ? "" : messages[key];
      valid = valid && fieldValid;
    });

    if (!valid) {
      const firstInvalid = form.querySelector('[aria-invalid="true"]');
      if (firstInvalid) firstInvalid.focus();
    }
    return valid;
  }

  function renderQuestion() {
    clearTimers();
    locked = false;
    secondsLeft = serverMode ? remoteSecondsRemaining : questionDurationSeconds;

    const question = serverMode ? remoteQuestion : questions[currentQuestion];
    if (!question) throw new Error("Soal aktif tidak tersedia.");
    const answeredCount = currentQuestion;
    const percentage = Math.round((answeredCount / questions.length) * 100);
    questionCount.textContent = `SOAL ${currentQuestion + 1} DARI ${questions.length}`;
    questionPercent.textContent = `${percentage}%`;
    progress.setAttribute("aria-valuemax", String(questions.length));
    progress.setAttribute("aria-valuenow", String(answeredCount));
    progressBar.style.width = `${percentage}%`;
    questionText.textContent = question.question;
    timerElement.textContent = formatTime(secondsLeft);
    timerElement.classList.remove("is-low");
    quizStatus.textContent = "Pilih satu jawaban. Pilihan akan langsung dikunci.";

    answerOptions.replaceChildren();
    question.options.forEach((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "zona-answer";
      button.innerHTML = `<span class="zona-answer-letter">${answerLetters[index]}</span><span></span>`;
      button.lastElementChild.textContent = option;
      button.addEventListener("click", () => {
        lockAnswer(index);
      });
      answerOptions.appendChild(button);
    });

    questionContent.classList.remove("zona-enter");
    void questionContent.offsetWidth;
    questionContent.classList.add("zona-enter");
    questionText.focus({ preventScroll: true });
    timerId = window.setInterval(tick, 1000);
  }

  function tick() {
    secondsLeft = Math.max(0, secondsLeft - 1);
    timerElement.textContent = formatTime(secondsLeft);
    timerElement.classList.toggle("is-low", secondsLeft <= 5);
    if (secondsLeft === 10 || secondsLeft === 5) {
      quizStatus.textContent = `Sisa waktu ${secondsLeft} detik.`;
    }
    if (secondsLeft === 0) {
      clearTimers();
      locked = true;
      Array.from(answerOptions.querySelectorAll("button")).forEach((button) => {
        button.disabled = true;
      });
      quizStatus.textContent = "Waktu habis. Jawaban tidak diisi dan tidak mendapat poin; soal berikutnya segera ditampilkan.";
      if (serverMode) {
        submitRemoteAnswer(null);
      } else {
        advanceId = window.setTimeout(advanceQuestion, 700);
      }
    }
  }

  function lockAnswer(selectedIndex) {
    if (locked) return;
    locked = true;
    clearTimers();
    const buttons = Array.from(answerOptions.querySelectorAll("button"));
    buttons.forEach((button, index) => {
      button.disabled = true;
      if (index === selectedIndex) button.classList.add("is-selected");
    });
    quizStatus.textContent = "Jawaban dikunci. Soal berikutnya segera ditampilkan.";
    if (serverMode) {
      submitRemoteAnswer(selectedIndex);
    } else {
      advanceId = window.setTimeout(advanceQuestion, 700);
    }
  }

  function applyRemoteState(state) {
    clearTimers();
    if (state.completed === true) {
      document.getElementById("complete-message").textContent =
        "Tes berhasil diselesaikan! Terima kasih telah berpartisipasi dalam Zona Interaktif PeKA Bank Indonesia Jawa Timur. Jawaban Anda telah tersimpan di sistem.";
      const emailStatus = state.email_status || "unknown";
      const emailMessages = {
        accepted: "Permintaan email konfirmasi telah diterima oleh penyedia email.",
        sending: "Email konfirmasi sedang diproses. Status dapat diperiksa kembali sebentar lagi.",
        retry_wait: "Penyedia email belum menerima permintaan. Anda dapat mencoba kembali setelah jeda singkat.",
        failed: "Tes tersimpan, tetapi pengiriman email konfirmasi gagal. Silakan coba kembali atau hubungi administrator.",
        not_configured: "Tes tersimpan. Email konfirmasi belum dikonfigurasi oleh administrator.",
        not_queued: "Tes tersimpan, tetapi email konfirmasi tidak tersedia untuk sesi ini. Hubungi administrator.",
        not_ready: "Tes tersimpan, tetapi sesi belum memenuhi pemeriksaan pengiriman email. Hubungi administrator.",
        unknown: "Tes tersimpan. Status email konfirmasi belum dapat dipastikan."
      };
      completeEmailStatus.textContent = emailMessages[emailStatus] || emailMessages.unknown;
      retryEmailButton.classList.toggle("zona-hidden", state.email_retryable !== true);
      retryEmailButton.disabled = false;
      showPanel(completePanel);
      return;
    }
    if (!state.question || !Number.isInteger(state.question.order) ||
        !Array.isArray(state.question.options) || state.question.options.length !== 4) {
      throw new Error("Respons server tidak memuat soal aktif yang valid.");
    }
    remoteQuestion = state.question;
    remoteSecondsRemaining = Math.max(1, Math.min(questionDurationSeconds, Number(state.seconds_remaining) || questionDurationSeconds));
    currentQuestion = remoteQuestion.order - 1;
    renderQuestion();
    if (state.feedback?.is_correct === true) {
      quizStatus.textContent = "Jawaban soal sebelumnya benar berdasarkan kunci tabel dokumen.";
    } else if (state.feedback?.is_correct === false) {
      quizStatus.textContent = "Jawaban soal sebelumnya belum tepat berdasarkan kunci tabel dokumen.";
    }
  }

  async function synchronizeRemoteSession(message) {
    try {
      const state = await callQuizService({
        action: "current",
        session_id: sessionId,
        email: pendingIdentity.email
      });
      applyRemoteState(state);
      if (message) quizStatus.textContent = message;
    } catch (error) {
      quizStatus.textContent = `${error.message} Periksa koneksi, lalu coba sinkronkan sesi.`;
      document.getElementById("sync-session").classList.remove("zona-hidden");
    }
  }

  async function submitRemoteAnswer(selectedOption) {
    try {
      const state = await callQuizService({
        action: "answer",
        session_id: sessionId,
        email: pendingIdentity.email,
        question_order: currentQuestion + 1,
        selected_option: selectedOption
      });
      applyRemoteState(state);
      if (!state.completed) {
        const savedMessage = state.answer_timed_out === true
          ? "Waktu habis; soal sebelumnya tersimpan sebagai tidak dijawab dan tidak mendapat poin."
          : "Jawaban tersimpan di server.";
        quizStatus.textContent = `${savedMessage} ${quizStatus.textContent}`;
      }
    } catch (error) {
      const message = error.message === "Respons soal sudah diterima atau sesi telah berpindah. Memuat posisi sesi terbaru."
        ? "Sesi telah disinkronkan."
        : error.message === "Waktu soal masih berjalan menurut server. Lanjutkan menjawab sampai waktunya habis."
          ? "Server memvalidasi timer; sisa waktu disinkronkan."
          : "Koneksi atau respons terganggu. Posisi soal disinkronkan dengan server.";
      await synchronizeRemoteSession(
        message
      );
    }
  }

  async function beginSession() {
    startStatus.textContent = "Membuat atau melanjutkan sesi tes…";
    const state = await callQuizService({
      action: "start",
      quiz_type: selectedQuizType,
      full_name: pendingIdentity.name,
      email: pendingIdentity.email,
      institution: pendingIdentity.institution
    });
    sessionId = state.session_id;
    serverMode = true;
    quizTypeLabel.textContent = selectedQuizType === "PRE_TEST" ? "PRE-TEST PeKA" : "POST-TEST PeKA";
    identityReview.classList.add("zona-hidden");
    showPanel(quizPanel);
    applyRemoteState(state);
  }

  function advanceQuestion() {
    clearTimers();
    if (currentQuestion === questions.length - 1) {
      showPanel(completePanel);
      return;
    }
    currentQuestion += 1;
    renderQuestion();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!validateParticipant()) return;
    selectedQuizType = document.querySelector('input[name="quiz-type"]:checked').value;
    currentQuestion = 0;
    pendingIdentity = {
      name: document.getElementById("participant-name").value.trim().replace(/\s+/g, " "),
      email: document.getElementById("participant-email").value.trim().toLowerCase(),
      institution: document.getElementById("participant-institution").value.trim().replace(/\s+/g, " ")
    };
    document.getElementById("review-name").textContent = pendingIdentity.name;
    document.getElementById("review-email").textContent = pendingIdentity.email;
    document.getElementById("review-institution").textContent = pendingIdentity.institution;
    document.getElementById("review-test-type").textContent =
      selectedQuizType === "PRE_TEST" ? "Pre-test" : "Post-test";
    startStatus.textContent = "";
    form.classList.add("zona-hidden");
    identityReview.classList.remove("zona-hidden");
  });

  document.getElementById("edit-identity").addEventListener("click", () => {
    identityReview.classList.add("zona-hidden");
    form.classList.remove("zona-hidden");
    document.getElementById("participant-name").focus();
  });

  document.getElementById("confirm-start").addEventListener("click", async (event) => {
    if (!pendingIdentity) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      if (!hasSupabaseConfig) {
        if (hasSupabaseUrl) {
          throw new Error("Integrasi backend belum lengkap. Kuis dinonaktifkan sampai konfigurasi Supabase diperbaiki.");
        }
        serverMode = false;
        quizTypeLabel.textContent = selectedQuizType === "PRE_TEST"
          ? "PRE-TEST PeKA · PRATINJAU"
          : "POST-TEST PeKA · PRATINJAU";
        identityReview.classList.add("zona-hidden");
        showPanel(quizPanel);
        renderQuestion();
        return;
      }
      await beginSession();
    } catch (error) {
      startStatus.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  retryEmailButton.addEventListener("click", async () => {
    retryEmailButton.disabled = true;
    completeEmailStatus.textContent = "Memeriksa dan mencoba mengirim email konfirmasi…";
    try {
      const state = await callQuizService({
        action: "retry_email",
        session_id: sessionId,
        email: pendingIdentity.email
      });
      applyRemoteState(state);
    } catch (error) {
      completeEmailStatus.textContent = `${error.message} Hasil tes tetap tersimpan.`;
      retryEmailButton.disabled = false;
    }
  });

  document.getElementById("sync-session").addEventListener("click", () => {
    document.getElementById("sync-session").classList.add("zona-hidden");
    synchronizeRemoteSession("Sesi berhasil disinkronkan.");
  });

  document.getElementById("exit-quiz").addEventListener("click", () => {
    clearTimers();
    serverMode = false;
    sessionId = "";
    pendingIdentity = null;
    identityReview.classList.add("zona-hidden");
    form.classList.remove("zona-hidden");
    form.reset();
    showPanel(setupPanel);
  });

  document.getElementById("restart-quiz").addEventListener("click", () => {
    clearTimers();
    serverMode = false;
    sessionId = "";
    pendingIdentity = null;
    identityReview.classList.add("zona-hidden");
    form.classList.remove("zona-hidden");
    completeEmailStatus.textContent = "";
    retryEmailButton.classList.add("zona-hidden");
    form.reset();
    currentQuestion = 0;
    showPanel(setupPanel);
  });

  window.addEventListener("pagehide", () => {
    clearTimers();
  });
})();
