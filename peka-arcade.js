(function () {
  "use strict";

  const GAME_KEYS = ["slice", "shooter", "whack", "bomb", "catch"];
  const GAME_NAMES = {
    slice: "Slice the Scam",
    shooter: "Destroy the Fraud",
    whack: "Whack a Scam",
    bomb: "Bomb Defuser",
    catch: "Tangkap yang Aman"
  };
  const SAFE_ITEMS = ["Verifikasi", "STOP dulu", "Blokir", "Cek resmi", "Tolak OTP"];
  const FRAUD_ITEMS = ["Minta OTP", "APK palsu", "Link palsu", "Hadiah palsu", "Akun palsu"];
  const SCENARIOS = [
    {
      prompt: "Seseorang mengaku petugas bank dan meminta kode OTP untuk membatalkan transaksi.",
      options: ["Berikan OTP agar cepat dibantu", "Tolak, tutup telepon, lalu hubungi kanal resmi", "Kirim foto kartu debit"],
      correct: 1,
      note: "Bank tidak meminta OTP, PIN, atau password."
    },
    {
      prompt: "Anda menerima APK lewat chat untuk mengecek bantuan yang mengatasnamakan bank.",
      options: ["Instal agar bantuan bisa dicairkan", "Teruskan ke semua kontak", "Jangan instal; cek informasi lewat kanal resmi"],
      correct: 2,
      note: "Aplikasi dari tautan tidak resmi dapat mencuri data dan akses perangkat."
    },
    {
      prompt: "Pesan mendesak meminta Anda membuka tautan dan memasukkan data kartu.",
      options: ["Jangan buka; ketik alamat resmi sendiri atau hubungi penerbit", "Masukkan data sebelum tautan kedaluwarsa", "Balas dengan nomor kartu"],
      correct: 0,
      note: "Jangan gunakan tautan pesan untuk masuk atau membayar."
    },
    {
      prompt: "Transfer masuk yang tidak dikenal lalu seseorang meminta Anda mengembalikannya ke rekening lain.",
      options: ["Kembalikan ke rekening yang dikirim lewat chat", "Hubungi bank melalui kanal resmi dan jangan pindahkan dana", "Berikan kode verifikasi"],
      correct: 1,
      note: "Minta bank membantu menelusuri transaksi; jangan mengikuti instruksi pengirim."
    },
    {
      prompt: "Tawaran hadiah meminta biaya administrasi ke rekening pribadi.",
      options: ["Bayar supaya hadiah tidak hangus", "Kirim OTP sebagai bukti", "Hentikan komunikasi dan verifikasi penyelenggara"],
      correct: 2,
      note: "Waspadai tekanan waktu dan pembayaran tak terduga."
    }
  ];

  const statusElement = document.getElementById("arcade-status");
  const config = window.PEKA_SUPABASE_CONFIG || {};
  const validConfig = typeof config.url === "string" &&
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.url) &&
    typeof config.anonKey === "string" &&
    (/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.anonKey.trim()) ||
      /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(config.anonKey.trim()));
  const supabaseClient = validConfig && window.supabase?.createClient
    ? window.supabase.createClient(config.url, config.anonKey.trim())
    : null;

  const entryPanel = document.getElementById("entry-panel");
  const adminPanel = document.getElementById("admin-panel");
  const playerPanel = document.getElementById("player-panel");
  const joinForm = document.getElementById("join-form");
  const adminForm = document.getElementById("admin-login-form");
  const roomCreate = document.getElementById("room-create");
  const adminRoom = document.getElementById("admin-room");
  const roomIdStorage = "peka-arcade-room";
  const playerStorage = "peka-arcade-player";
  let adminUser = null;
  let adminRoomId = sessionStorage.getItem(roomIdStorage) || "";
  let playerCredentials = readPlayerCredentials();
  let roomState = null;
  let lastRenderedGameIndex = 0;
  let roomChannel = null;
  let adminScoreChannel = null;
  let roomRealtimeReady = false;
  let adminRealtimeReady = false;
  let pollingTimer = null;
  let playerRefreshPending = false;
  let transitionTimer = null;
  let adminRefreshTimer = null;
  let adminRefreshPending = false;
  let polling = false;
  let scoreTimer = null;
  let lastScoreSent = "";
  let serverOffset = 0;
  let activeGame = null;
  let animationId = 0;
  let lastFrameTime = 0;
  let lastWhackTime = 0;
  let whackIndex = -1;
  let bombStep = -1;
  let bombAnsweredStep = -1;
  const audioStorageKey = "peka-arcade-audio";
  const audioDefaults = { musicEnabled: true, effectsEnabled: true, musicVolume: 0.35, effectsVolume: 0.65 };
  let audioSettings = { ...audioDefaults };
  let audioContext = null;
  let musicGain = null;
  let effectsGain = null;
  let musicTimer = null;
  let musicStep = 0;
  let musicScene = "menu";
  let effectVoice = null;
  let pendingCountdown = "";
  let pendingVictory = false;
  let countdownTimers = [];
  let pointer = { x: 0, y: 0, down: false, lastX: 0, lastY: 0 };
  const canvas = document.getElementById("arcade-canvas");
  const canvasFrame = document.getElementById("canvas-frame");
  const ctx = canvas.getContext("2d");
  const whackBoard = document.getElementById("whack-board");
  const bombPanel = document.getElementById("bomb-panel");

  function loadAudioSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(audioStorageKey) || "null");
      if (!saved || typeof saved !== "object") return;
      audioSettings = {
        musicEnabled: saved.musicEnabled !== false,
        effectsEnabled: saved.effectsEnabled !== false,
        musicVolume: Number.isFinite(saved.musicVolume)
          ? Math.max(0, Math.min(1, saved.musicVolume)) : audioDefaults.musicVolume,
        effectsVolume: Number.isFinite(saved.effectsVolume)
          ? Math.max(0, Math.min(1, saved.effectsVolume)) : audioDefaults.effectsVolume
      };
    } catch {
      audioSettings = { ...audioDefaults };
    }
  }

  function saveAudioSettings() {
    try {
      localStorage.setItem(audioStorageKey, JSON.stringify(audioSettings));
    } catch {
      setStatus("Pengaturan audio aktif untuk sesi ini, tetapi tidak dapat disimpan di perangkat.", "error");
    }
  }

  function renderAudioSettings() {
    const musicToggle = document.getElementById("music-toggle");
    const effectsToggle = document.getElementById("effects-toggle");
    musicToggle.textContent = `Musik: ${audioSettings.musicEnabled ? "ON" : "OFF"}`;
    effectsToggle.textContent = `Efek: ${audioSettings.effectsEnabled ? "ON" : "OFF"}`;
    musicToggle.setAttribute("aria-pressed", String(audioSettings.musicEnabled));
    effectsToggle.setAttribute("aria-pressed", String(audioSettings.effectsEnabled));
    document.getElementById("music-volume").value = String(Math.round(audioSettings.musicVolume * 100));
    document.getElementById("effects-volume").value = String(Math.round(audioSettings.effectsVolume * 100));
    document.getElementById("music-volume-value").value = `${Math.round(audioSettings.musicVolume * 100)}%`;
    document.getElementById("effects-volume-value").value = `${Math.round(audioSettings.effectsVolume * 100)}%`;
  }

  function initializeAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    if (!audioContext) {
      audioContext = new AudioContextClass();
      musicGain = audioContext.createGain();
      effectsGain = audioContext.createGain();
      musicGain.connect(audioContext.destination);
      effectsGain.connect(audioContext.destination);
      updateAudioGains();
    }
    if (audioContext.state === "suspended") audioContext.resume();
    return true;
  }

  function updateAudioGains() {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    musicGain.gain.setTargetAtTime(
      audioSettings.musicEnabled ? audioSettings.musicVolume : 0, now, 0.04
    );
    effectsGain.gain.setTargetAtTime(
      audioSettings.effectsEnabled ? audioSettings.effectsVolume : 0, now, 0.025
    );
  }

  function stopMusic() {
    if (musicTimer) window.clearInterval(musicTimer);
    musicTimer = null;
  }

  function startMusic() {
    if (!audioContext || !audioSettings.musicEnabled || musicTimer) return;
    const menuNotes = [261.63, 329.63, 392, 329.63, 293.66, 349.23, 440, 349.23];
    const arcadeNotes = [392, 523.25, 587.33, 523.25, 440, 587.33, 659.25, 587.33];
    const notes = musicScene === "arcade" ? arcadeNotes : menuNotes;
    musicStep = 0;
    const playMusicNote = () => {
      if (!audioContext || !audioSettings.musicEnabled) return;
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const envelope = audioContext.createGain();
      const note = notes[musicStep % notes.length];
      musicStep++;
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(note, now);
      envelope.gain.setValueAtTime(0.0001, now);
      envelope.gain.exponentialRampToValueAtTime(0.12, now + 0.025);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      oscillator.connect(envelope);
      envelope.connect(musicGain);
      oscillator.start(now);
      oscillator.stop(now + 0.25);
    };
    playMusicNote();
    musicTimer = window.setInterval(playMusicNote, 280);
  }

  function setMusicScene(scene) {
    if (musicScene === scene) return;
    musicScene = scene;
    stopMusic();
    startMusic();
  }

  function cancelCountdown() {
    countdownTimers.forEach((timer) => window.clearTimeout(timer));
    countdownTimers = [];
    pendingCountdown = "";
  }

  function playToneSequence(notes, waveform, duration) {
    if (!audioContext || !audioSettings.effectsEnabled || !notes.length) return;
    const now = audioContext.currentTime;
    if (effectVoice) {
      try {
        effectVoice.gain.gain.cancelScheduledValues(now);
        effectVoice.gain.gain.setTargetAtTime(0.0001, now, 0.008);
        effectVoice.oscillator.stop(now + 0.04);
      } catch {
        // The previous one-shot may already have finished.
      }
    }
    const oscillator = audioContext.createOscillator();
    const envelope = audioContext.createGain();
    oscillator.type = waveform || "sine";
    oscillator.connect(envelope);
    envelope.connect(effectsGain);
    notes.forEach((note, index) => {
      const start = now + index * duration;
      oscillator.frequency.setValueAtTime(note, start);
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.linearRampToValueAtTime(0.8, start + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration * 0.9);
    });
    const end = now + notes.length * duration;
    oscillator.start(now);
    oscillator.stop(end);
    effectVoice = { oscillator, gain: envelope };
    oscillator.onended = () => {
      if (effectVoice && effectVoice.oscillator === oscillator) effectVoice = null;
    };
  }

  function playAudioEffect(name, gameKey, variation) {
    const gameNotes = {
      slice: [784, 1174],
      shooter: [660, 440],
      whack: [220, 330],
      bomb: [523, 784],
      catch: [392, 587]
    };
    const profiles = {
      score: [gameNotes[gameKey]?.[0] || 660],
      combo: [659, 784, 988],
      bonus: [784, 988, 1174],
      lifeLost: [330, 220],
      gameWin: [523, 659, 784],
      gameLose: [330, 247, 196],
      victory: [523, 659, 784, 1047],
      countdown: [440],
      go: [659, 880]
    };
    const waveforms = { score: "sine", combo: "triangle", bonus: "triangle", lifeLost: "sawtooth",
      gameWin: "triangle", gameLose: "sawtooth", victory: "triangle", countdown: "sine", go: "triangle" };
    const countdownNotes = [[659], [587], [523]];
    const notes = name === "countdown" ? countdownNotes[variation] : profiles[name];
    playToneSequence(notes, waveforms[name], name === "victory" ? 0.13 : 0.095);
  }

  function runCountdown(gameKey) {
    pendingCountdown = "";
    cancelCountdown();
    [0, 1, 2, 3].forEach((index) => {
      countdownTimers.push(window.setTimeout(() => {
        playAudioEffect(index === 3 ? "go" : "countdown", gameKey, index);
      }, index * 520));
    });
  }

  function unlockAudio() {
    if (!initializeAudioContext()) return;
    startMusic();
    if (pendingCountdown) runCountdown(pendingCountdown);
    if (pendingVictory) {
      pendingVictory = false;
      playAudioEffect("victory");
    }
  }

  function queueGameCountdown(gameKey) {
    cancelCountdown();
    if (audioContext && audioContext.state === "running") runCountdown(gameKey);
    else pendingCountdown = gameKey;
  }

  function announceWinner() {
    if (audioContext && audioContext.state === "running") playAudioEffect("victory");
    else pendingVictory = true;
  }

  function bindAudioControls() {
    loadAudioSettings();
    renderAudioSettings();
    document.addEventListener("pointerdown", (event) => {
      if (event.target === document.getElementById("music-toggle") && audioSettings.musicEnabled) {
        initializeAudioContext();
      } else {
        unlockAudio();
      }
    }, { capture: true, once: true });
    document.addEventListener("keydown", unlockAudio, { capture: true, once: true });
    document.getElementById("music-toggle").addEventListener("click", () => {
      initializeAudioContext();
      audioSettings.musicEnabled = !audioSettings.musicEnabled;
      updateAudioGains();
      if (audioSettings.musicEnabled) startMusic();
      else stopMusic();
      saveAudioSettings();
      renderAudioSettings();
    });
    document.getElementById("effects-toggle").addEventListener("click", () => {
      unlockAudio();
      audioSettings.effectsEnabled = !audioSettings.effectsEnabled;
      updateAudioGains();
      saveAudioSettings();
      renderAudioSettings();
    });
    [["music-volume", "musicVolume"], ["effects-volume", "effectsVolume"]].forEach(([id, setting]) => {
      document.getElementById(id).addEventListener("input", (event) => {
        unlockAudio();
        audioSettings[setting] = Number(event.target.value) / 100;
        updateAudioGains();
        saveAudioSettings();
        renderAudioSettings();
      });
    });
  }

  function setStatus(message, type) {
    statusElement.textContent = message;
    statusElement.classList.toggle("error", type === "error");
    statusElement.classList.toggle("success", type === "success");
  }

  function readPlayerCredentials() {
    try {
      return JSON.parse(sessionStorage.getItem(playerStorage) || "null");
    } catch {
      return null;
    }
  }

  function persistPlayerCredentials(value) {
    playerCredentials = value;
    sessionStorage.setItem(playerStorage, JSON.stringify(value));
  }

  function normalizeRpcError(error) {
    const messages = {
      admin_access_required: "Akun ini belum memiliki peran admin PeKA terverifikasi.",
      admin_room_access_denied: "Room ini dibuat oleh admin lain.",
      room_not_joinable: "Room tidak ditemukan atau sudah dimulai/ditutup.",
      room_full: "Room sudah mencapai batas 300 peserta.",
      name_already_in_room: "Nama tersebut sudah digunakan di room ini.",
      room_access_denied: "Akses room tidak valid. Gabung kembali dengan PIN.",
      room_not_found: "Room tidak ditemukan atau sudah ditutup.",
      invalid_join_details: "Periksa PIN enam digit dan nama (2–36 karakter).",
      invalid_game_order: "Urutan harus berisi masing-masing lima game satu kali.",
      invalid_room_settings: "Pengaturan room tidak valid.",
      invalid_room_transition: "Aksi tidak tersedia untuk status room saat ini.",
      score_out_of_bounds: "Skor di luar batas yang diizinkan server.",
      score_window_expired: "Waktu pengiriman skor game ini sudah lewat."
    };
    const code = error?.message?.split(":")[0] || "";
    return messages[code] || error?.message || "Permintaan gagal. Coba lagi.";
  }

  async function rpc(name, args) {
    if (!supabaseClient) throw new Error("Supabase belum siap.");
    const { data, error } = await supabaseClient.rpc(name, args);
    if (error) throw new Error(normalizeRpcError(error));
    return data;
  }

  function showPanel(panel) {
    [entryPanel, adminPanel, playerPanel].forEach((item) => item.classList.add("hidden"));
    panel.classList.remove("hidden");
  }

  function setupGameOrder() {
    const container = document.getElementById("game-order-inputs");
    const labels = ["Slice", "Shooter", "Whack", "Bomb", "Tangkap"];
    container.replaceChildren();
    GAME_KEYS.forEach((defaultKey, index) => {
      const label = document.createElement("label");
      label.append(document.createTextNode(`Game ${index + 1}`));
      const select = document.createElement("select");
      select.dataset.index = String(index);
      GAME_KEYS.forEach((key, optionIndex) => {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = labels[optionIndex];
        option.selected = key === defaultKey;
        select.append(option);
      });
      label.append(select);
      container.append(label);
    });
  }

  function selectedGameOrder() {
    return Array.from(document.querySelectorAll("#game-order-inputs select"))
      .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
      .map((select) => select.value);
  }

  async function signInAdmin(event) {
    event.preventDefault();
    if (!supabaseClient) return;
    const button = adminForm.querySelector("button");
    button.disabled = true;
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: document.getElementById("admin-email").value.trim(),
        password: document.getElementById("admin-password").value
      });
      if (error) throw error;
      if (data.user?.app_metadata?.peka_admin !== true) {
        await supabaseClient.auth.signOut();
        throw new Error("Login berhasil, tetapi akun ini belum diberi peran admin PeKA.");
      }
      adminUser = data.user;
      adminForm.reset();
      showPanel(adminPanel);
      if (adminRoomId) {
        try {
          await refreshAdminSnapshot();
          return;
        } catch {
          adminRoomId = "";
          sessionStorage.removeItem(roomIdStorage);
        }
      }
      roomCreate.classList.remove("hidden");
      adminRoom.classList.add("hidden");
      setStatus("Admin terverifikasi. Atur urutan game dan pengaturan sesi.", "success");
    } catch (error) {
      setStatus(normalizeRpcError(error), "error");
    } finally {
      button.disabled = false;
    }
  }

  async function restoreAdmin() {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    const user = data.session?.user;
    if (!user || user.app_metadata?.peka_admin !== true) return;
    adminUser = user;
    showPanel(adminPanel);
    if (adminRoomId) {
      try {
        await refreshAdminSnapshot();
        return;
      } catch {
        adminRoomId = "";
        sessionStorage.removeItem(roomIdStorage);
      }
    }
    roomCreate.classList.remove("hidden");
    adminRoom.classList.add("hidden");
    setStatus("Admin terverifikasi. Atur urutan game dan pengaturan sesi.", "success");
  }

  async function signOutAdmin() {
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
      setStatus("Sesi admin tidak dapat ditutup: " + error.message, "error");
      return;
    }
    adminUser = null;
    adminRoomId = "";
    sessionStorage.removeItem(roomIdStorage);
    stopRealtime();
    showPanel(entryPanel);
    setStatus("Anda telah keluar dari sesi admin.");
  }

  async function createRoom() {
    const order = selectedGameOrder();
    if (new Set(order).size !== GAME_KEYS.length) {
      setStatus("Pilih setiap mini-game tepat satu kali.", "error");
      return;
    }
    const button = document.getElementById("create-room");
    button.disabled = true;
    try {
      const data = await rpc("create_peka_arcade_room", {
        p_game_order: order,
        p_game_duration_seconds: Number(document.getElementById("game-duration").value),
        p_lives: Number(document.getElementById("game-lives").value),
        p_difficulty: document.getElementById("game-difficulty").value
      });
      adminRoomId = data.room_id;
      sessionStorage.setItem(roomIdStorage, adminRoomId);
      roomCreate.classList.add("hidden");
      adminRoom.classList.remove("hidden");
      showPanel(adminPanel);
      await connectRealtime(adminRoomId, true);
      await refreshAdminSnapshot();
      setStatus("Room dibuat. Bagikan PIN atau QR kepada peserta.", "success");
    } catch (error) {
      setStatus(normalizeRpcError(error), "error");
    } finally {
      button.disabled = false;
    }
  }

  async function joinRoom(event) {
    event.preventDefault();
    const button = joinForm.querySelector("button");
    const pin = document.getElementById("join-pin").value.trim();
    const name = document.getElementById("join-name").value.trim();
    button.disabled = true;
    try {
      const data = await rpc("join_peka_arcade_room", {
        p_pin: pin,
        p_display_name: name
      });
      persistPlayerCredentials({
        roomId: data.room_id,
        participantId: data.participant_id,
        participantToken: data.participant_token,
        pin: data.pin
      });
      joinForm.reset();
      await enterPlayerRoom();
      setStatus("Berhasil bergabung. Nama dan skor akan muncul pada leaderboard room.", "success");
    } catch (error) {
      setStatus(normalizeRpcError(error), "error");
    } finally {
      button.disabled = false;
    }
  }

  async function enterPlayerRoom() {
    if (!playerCredentials?.roomId || !playerCredentials?.participantToken) return false;
    showPanel(playerPanel);
    document.getElementById("player-pin").textContent = playerCredentials.pin;
    await connectRealtime(playerCredentials.roomId, false);
    await refreshPlayerSnapshot();
    return true;
  }

  function stopRealtime() {
    if (pollingTimer) window.clearInterval(pollingTimer);
    pollingTimer = null;
    if (transitionTimer) window.clearTimeout(transitionTimer);
    if (adminRefreshTimer) window.clearTimeout(adminRefreshTimer);
    transitionTimer = null;
    adminRefreshTimer = null;
    playerRefreshPending = false;
    adminRefreshPending = false;
    if (roomChannel && supabaseClient) supabaseClient.removeChannel(roomChannel);
    if (adminScoreChannel && supabaseClient) supabaseClient.removeChannel(adminScoreChannel);
    roomChannel = null;
    adminScoreChannel = null;
    roomRealtimeReady = false;
    adminRealtimeReady = false;
  }

  async function connectRealtime(roomId, isAdmin) {
    stopRealtime();
    if (!supabaseClient) return;
    roomChannel = supabaseClient.channel(`peka-arcade:${roomId}`, {
      config: { private: true, broadcast: { self: false } }
    });
    roomChannel.on("broadcast", { event: "room_updated" }, () => {
      if (isAdmin) scheduleAdminRefresh();
      else if (playerCredentials?.roomId === roomId) refreshPlayerSnapshot();
    });
    roomChannel.subscribe((status) => {
      roomRealtimeReady = status === "SUBSCRIBED";
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setStatus("Realtime tidak tersambung; pembaruan otomatis tetap mencoba lewat polling.", "error");
      }
    });
    if (isAdmin) {
      adminScoreChannel = supabaseClient.channel(`peka-arcade-admin:${roomId}`, {
        config: { private: true, broadcast: { self: false } }
      });
      adminScoreChannel.on("broadcast", { event: "score_updated" }, scheduleAdminRefresh);
      adminScoreChannel.subscribe((status) => {
        adminRealtimeReady = status === "SUBSCRIBED";
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setStatus("Realtime leaderboard tidak tersambung; dashboard memakai polling.", "error");
        }
      });
    }
    pollingTimer = window.setInterval(() => {
      if (isAdmin && (!roomRealtimeReady || !adminRealtimeReady)) refreshAdminSnapshot();
      else if (!isAdmin && !roomRealtimeReady) refreshPlayerSnapshot();
    }, 10000);
  }

  function scheduleAdminRefresh() {
    if (adminRefreshTimer) window.clearTimeout(adminRefreshTimer);
    adminRefreshTimer = window.setTimeout(() => {
      adminRefreshTimer = null;
      if (polling) {
        adminRefreshPending = true;
        return;
      }
      refreshAdminSnapshot();
    }, 500);
  }

  function scheduleRoomTransition() {
    if (transitionTimer) window.clearTimeout(transitionTimer);
    transitionTimer = null;
    if (roomState?.status !== "running") return;
    const delay = Math.max(500, remainingGameMs() + Math.random() * 1500);
    transitionTimer = window.setTimeout(() => {
      transitionTimer = null;
      if (adminUser && adminRoomId === roomState?.id) refreshAdminSnapshot();
      else if (playerCredentials?.roomId === roomState?.id) refreshPlayerSnapshot();
    }, delay);
  }

  async function refreshAdminSnapshot() {
    if (!adminRoomId) return;
    if (polling) {
      adminRefreshPending = true;
      return;
    }
    polling = true;
    try {
      const data = await rpc("sync_peka_arcade_room", {
        p_room_id: adminRoomId,
        p_participant_id: null,
        p_participant_token: null
      });
      applySnapshot(data, true);
    } catch (error) {
      setStatus(normalizeRpcError(error), "error");
    } finally {
      polling = false;
      if (adminRefreshPending) {
        adminRefreshPending = false;
        scheduleAdminRefresh();
      }
    }
  }

  async function refreshPlayerSnapshot() {
    if (!playerCredentials) return;
    if (polling) {
      playerRefreshPending = true;
      return;
    }
    polling = true;
    try {
      const data = await rpc("sync_peka_arcade_room", {
        p_room_id: playerCredentials.roomId,
        p_participant_id: playerCredentials.participantId,
        p_participant_token: playerCredentials.participantToken
      });
      applySnapshot(data, false);
    } catch (error) {
      setStatus(normalizeRpcError(error), "error");
      if (/room_access_denied|room_not_found/.test(error.message)) {
        sessionStorage.removeItem(playerStorage);
        playerCredentials = null;
        stopRealtime();
        showPanel(entryPanel);
      }
    } finally {
      polling = false;
      if (playerRefreshPending) {
        playerRefreshPending = false;
        window.setTimeout(refreshPlayerSnapshot, 0);
      }
    }
  }

  function renderLeaderboard(rows, container, tableMode) {
    if (tableMode) {
      container.replaceChildren();
      rows.forEach((row, index) => {
        const tr = document.createElement("tr");
        [String(index + 1), row.display_name, String(row.total_score),
          String(row.correct_actions), (row.elapsed_ms / 1000).toFixed(1),
          String(row.games_completed)].forEach((value) => {
          const td = document.createElement("td");
          td.textContent = value;
          tr.append(td);
        });
        container.append(tr);
      });
      if (!rows.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 6;
        td.textContent = "Belum ada peserta bergabung.";
        tr.append(td);
        container.append(tr);
      }
      return;
    }
    container.replaceChildren();
    rows.slice(0, 10).forEach((row, index) => {
      const item = document.createElement("div");
      item.className = "mini-row";
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = index < 3 ? ["🥇", "🥈", "🥉"][index] : `#${index + 1}`;
      const name = document.createElement("strong");
      name.textContent = row.display_name;
      const score = document.createElement("b");
      score.textContent = `${row.total_score} poin`;
      item.append(rank, name, score);
      container.append(item);
    });
  }

  function applySnapshot(data, isAdmin) {
    const previousStatus = roomState?.status;
    roomState = data.room;
    serverOffset = Date.parse(roomState.server_now) - Date.now();
    setMusicScene(roomState.status === "running" ? "arcade" : "menu");
    if (isAdmin) renderAdminSnapshot(data);
    else renderPlayerSnapshot(data);
    if (roomState.status === "running" && !isAdmin) startCurrentGame();
    else if (roomState.status !== "running" && !isAdmin) stopGameLoop();
    if (roomState.status === "completed" && activeGame) submitScore(true);
    if (roomState.status === "completed" && previousStatus !== "completed") announceWinner();
    scheduleRoomTransition();
  }

  function renderAdminSnapshot(data) {
    adminPanel.classList.remove("hidden");
    roomCreate.classList.add("hidden");
    adminRoom.classList.remove("hidden");
    document.getElementById("room-pin").textContent = data.room.pin;
    document.getElementById("room-state").textContent = data.room.status;
    document.getElementById("participant-count").textContent = `${data.participant_count} peserta`;
    const url = new URL(location.href);
    url.search = `?pin=${encodeURIComponent(data.room.pin)}`;
    document.getElementById("room-link").href = url.href;
    const qr = document.getElementById("room-qr");
    qr.replaceChildren();
    if (window.QRCode) {
      new window.QRCode(qr, { text: url.href, width: 82, height: 82, colorDark: "#0b2242", colorLight: "#ffffff" });
    } else {
      qr.textContent = "QR gagal dimuat";
    }
    const isLobby = data.room.status === "lobby";
    document.getElementById("admin-start").disabled = !isLobby;
    document.getElementById("admin-pause").disabled = data.room.status !== "running";
    document.getElementById("admin-resume").disabled = data.room.status !== "paused";
    document.getElementById("admin-next").disabled = !["running", "paused"].includes(data.room.status);
    document.getElementById("admin-finish").disabled = !["lobby", "running", "paused"].includes(data.room.status);
    document.getElementById("admin-close").disabled = data.room.status === "closed";
    renderLeaderboard(data.leaderboard, document.getElementById("leaderboard-rows"), true);
  }

  function renderPlayerSnapshot(data) {
    playerPanel.classList.remove("hidden");
    document.getElementById("player-count").textContent = `${data.participant_count} peserta`;
    document.getElementById("player-lobby-board").classList.toggle("hidden", data.room.status === "completed");
    renderLeaderboard(data.leaderboard, document.getElementById("player-lobby-board"), false);
    const gameWrap = document.getElementById("game-wrap");
    const finalPanel = document.getElementById("final-panel");
    const title = document.getElementById("player-title");
    const message = document.getElementById("player-message");
    if (data.room.status === "running") {
      gameWrap.classList.remove("hidden");
      finalPanel.classList.add("hidden");
      title.textContent = GAME_NAMES[data.room.game_order[data.room.game_index - 1]] || "Permainan berlangsung";
      message.textContent = `Game ${data.room.game_index} dari 5 • Bergerak bersama seluruh peserta.`;
      document.getElementById("game-name").textContent =
        `${String(data.room.game_index).padStart(2, "0")} / 05 • ${title.textContent}`;
    } else if (data.room.status === "paused") {
      gameWrap.classList.remove("hidden");
      finalPanel.classList.add("hidden");
      title.textContent = "Permainan dijeda";
      message.textContent = "Tunggu fasilitator melanjutkan permainan.";
    } else if (data.room.status === "completed") {
      gameWrap.classList.add("hidden");
      finalPanel.classList.remove("hidden");
      title.textContent = "Sesi selesai";
      message.textContent = "Peringkat akhir lima permainan:";
      renderLeaderboard(data.leaderboard, document.getElementById("final-leaderboard"), false);
    } else if (data.room.status === "closed") {
      gameWrap.classList.add("hidden");
      title.textContent = "Room ditutup";
      message.textContent = "Sesi ini sudah berakhir.";
    } else {
      gameWrap.classList.add("hidden");
      finalPanel.classList.add("hidden");
      title.textContent = "Menunggu fasilitator";
      message.textContent = "Room akan dimulai bersama-sama saat fasilitator menekan Mulai.";
    }
  }

  async function adminAction(action) {
    if (!adminRoomId) return;
    try {
      const data = await rpc("admin_peka_arcade_action", {
        p_room_id: adminRoomId,
        p_action: action,
        p_game_order: action === "configure" ? selectedGameOrder() : null,
        p_game_duration_seconds: action === "configure"
          ? Number(document.getElementById("game-duration").value) : null,
        p_lives: action === "configure" ? Number(document.getElementById("game-lives").value) : null,
        p_difficulty: action === "configure" ? document.getElementById("game-difficulty").value : null
      });
      applySnapshot(data, true);
      setStatus(`Aksi "${action}" berhasil.`, "success");
    } catch (error) {
      setStatus(normalizeRpcError(error), "error");
    }
  }

  function exportCsv() {
    if (!roomState) return;
    rpc("get_peka_arcade_snapshot", { p_room_id: adminRoomId, p_participant_id: null, p_participant_token: null })
      .then((data) => {
        const rows = [["Peringkat", "Nama peserta/tim", "Skor total", "Aksi benar", "Waktu (detik)", "Game selesai"]];
        data.leaderboard.forEach((row, index) => rows.push([
          index + 1, row.display_name, row.total_score, row.correct_actions,
          (row.elapsed_ms / 1000).toFixed(1), row.games_completed
        ]));
        const csv = rows.map((row) => row.map((cell) => {
              const value = typeof cell === "string" && /^\s*[=+\-@]/.test(cell) ? `'${cell}` : String(cell);
          return `"${value.replace(/"/g, '""')}"`;
        }).join(",")).join("\r\n");
        const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `peka-arcade-${data.room.pin}.csv`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      })
      .catch((error) => setStatus(normalizeRpcError(error), "error"));
  }

  function configureCanvas() {
    const rect = canvasFrame.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (activeGame) {
      activeGame.width = rect.width;
      activeGame.height = rect.height;
    }
  }

  function startCurrentGame() {
    const key = roomState.game_order[roomState.game_index - 1];
    if (!key) return;
    if (!activeGame || activeGame.key !== key || lastRenderedGameIndex !== roomState.game_index) {
      if (activeGame) submitScore(true);
      stopGameLoop();
      activeGame = {
        key, score: 0, correct: 0, lives: roomState.lives, combo: 0,
        startedAt: Date.now() + serverOffset,
        width: 0, height: 0, targets: [], bullets: [], lastSpawn: 0,
        lastShot: 0, playerX: canvas.clientWidth / 2, lastSubmit: "",
        fragments: [], outOfLives: false, finished: false
      };
      lastRenderedGameIndex = roomState.game_index;
      lastWhackTime = 0;
      whackIndex = -1;
      bombStep = -1;
      bombAnsweredStep = -1;
      setupGameSurface(key);
      configureCanvas();
      document.getElementById("game-instructions").textContent = instructionsFor(key);
      queueGameCountdown(key);
    }
    if (!animationId) {
      lastFrameTime = 0;
      animationId = window.requestAnimationFrame(gameFrame);
    }
  }

  function setupGameSurface(key) {
    canvasFrame.classList.toggle("hidden", key === "whack" || key === "bomb");
    whackBoard.classList.toggle("hidden", key !== "whack");
    bombPanel.classList.toggle("hidden", key !== "bomb");
    if (key === "whack") {
      whackBoard.replaceChildren();
      for (let index = 0; index < 9; index++) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "whack-hole";
        button.textContent = "—";
        button.setAttribute("aria-label", `Lubang ${index + 1}, kosong`);
        button.addEventListener("click", () => whack(index));
        whackBoard.append(button);
      }
    }
  }

  function instructionsFor(key) {
    return {
      slice: "Swipe target aman untuk poin; jangan potong modus penipuan.",
      shooter: "Geser untuk membidik, ketuk/tahan untuk menembak modus penipuan.",
      whack: "Tekan modus penipuan; hindari tindakan aman.",
      bomb: "Pilih respons aman sebelum waktu habis.",
      catch: "Geser keranjang untuk menangkap tindakan aman, hindari modus."
    }[key];
  }

  function stopGameLoop() {
    if (animationId) window.cancelAnimationFrame(animationId);
    animationId = 0;
    pointer.down = false;
    if (roomState?.status !== "running") cancelCountdown();
    if (activeGame && roomState?.status !== "running") submitScore(true);
  }

  function finishGame(won) {
    if (!activeGame || activeGame.finished) return;
    activeGame.finished = true;
    playAudioEffect(won ? "gameWin" : "gameLose", activeGame.key);
  }

  function remainingGameMs() {
    if (!roomState?.game_ends_at) return 0;
    return Math.max(0, Date.parse(roomState.game_ends_at) - (Date.now() + serverOffset));
  }

  function gameFrame(now) {
    animationId = 0;
    if (!roomState || roomState.status !== "running" || !activeGame) return;
    const delta = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 0.06) : 0;
    lastFrameTime = now;
    const remaining = remainingGameMs();
    const elapsed = Math.max(0, roomState.game_duration_seconds * 1000 - remaining);
    activeGame.elapsedMs = Math.min(roomState.game_duration_seconds * 1000, elapsed);
    document.getElementById("game-timer").textContent = formatClock(Math.ceil(remaining / 1000));
    document.getElementById("player-score").textContent = `${activeGame.score} poin`;
    document.getElementById("player-lives").textContent = `Nyawa ${activeGame.lives}`;

    if (!activeGame.outOfLives) {
      if (activeGame.key === "whack") updateWhack(now, remaining);
      else if (activeGame.key === "bomb") updateBomb(elapsed, remaining);
      else updateCanvasGame(delta, now);
    }
    if (remaining <= 0) {
      finishGame(activeGame.score > 0 || activeGame.correct > 0);
      submitScore(true);
      return;
    }
    animationId = window.requestAnimationFrame(gameFrame);
  }

  function formatClock(seconds) {
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function spawnTarget(key) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const good = key === "slice" || key === "catch"
      ? Math.random() < 0.62
      : Math.random() < 0.2;
    const label = good
      ? SAFE_ITEMS[Math.floor(Math.random() * SAFE_ITEMS.length)]
      : FRAUD_ITEMS[Math.floor(Math.random() * FRAUD_ITEMS.length)];
    const radius = Math.max(20, Math.min(34, width * 0.065));
    const target = {
      x: radius + Math.random() * Math.max(1, width - radius * 2),
      y: key === "slice" ? height + radius : -radius,
      radius, good, label,
      vx: (Math.random() - 0.5) * 55,
      vy: key === "slice"
        ? -(170 + Math.random() * 120) * difficultyFactor()
        : (115 + Math.random() * 110) * difficultyFactor()
    };
    activeGame.targets.push(target);
  }

  function difficultyFactor() {
    return roomState.difficulty === "hard" ? 1.35 : roomState.difficulty === "easy" ? 0.78 : 1;
  }

  function updateCanvasGame(delta, now) {
    if (!activeGame.width || !activeGame.height) configureCanvas();
    const rate = roomState.difficulty === "hard" ? 620 : roomState.difficulty === "easy" ? 1100 : 850;
    if (now - activeGame.lastSpawn > rate) {
      spawnTarget(activeGame.key);
      activeGame.lastSpawn = now;
    }
    if (activeGame.key === "shooter" && pointer.down && now - activeGame.lastShot > 220) {
      activeGame.bullets.push({ x: activeGame.playerX, y: activeGame.height - 44, vy: -470 });
      activeGame.lastShot = now;
    }
    const { width, height } = activeGame;
    const remainingTargets = [];
    activeGame.targets.forEach((target) => {
      if (activeGame.key === "slice") target.vy += 350 * delta;
      target.x += target.vx * delta;
      target.y += target.vy * delta;
      if (activeGame.key === "catch" && target.y + target.radius >= height - 33 &&
          target.x > activeGame.playerX - 54 && target.x < activeGame.playerX + 54) {
        resolveTarget(target, target.good, "catch");
        return;
      }
      if (target.y > height + target.radius || target.y < -target.radius * 2) return;
      remainingTargets.push(target);
    });
    activeGame.targets = remainingTargets;
    if (activeGame.key === "catch") {
      activeGame.playerX = Math.max(45, Math.min(width - 45, activeGame.playerX));
    }
    if (activeGame.key === "shooter") updateBullets(delta);
    drawCanvas();
  }

  function updateBullets(delta) {
    activeGame.bullets.forEach((bullet) => { bullet.y += bullet.vy * delta; });
    activeGame.bullets = activeGame.bullets.filter((bullet) => bullet.y > -10);
    const remaining = [];
    activeGame.targets.forEach((target) => {
      const hitIndex = activeGame.bullets.findIndex((bullet) =>
        Math.hypot(target.x - bullet.x, target.y - bullet.y) < target.radius + 5);
      if (hitIndex < 0) {
        remaining.push(target);
      } else {
        activeGame.bullets.splice(hitIndex, 1);
        resolveTarget(target, !target.good, "shooter");
      }
    });
    activeGame.targets = remaining;
  }

  function drawCanvas() {
    const { width, height, key } = activeGame;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.2;
    for (let i = 0; i < 16; i++) {
      const x = (i * 73 + 23) % width;
      const y = (i * 97 + 41) % height;
      ctx.beginPath(); ctx.arc(x, y, i % 3 === 0 ? 1.5 : 1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (key === "catch") drawBasket(width, height);
    if (key === "shooter") drawShooter(width, height);
    activeGame.targets.forEach(drawTarget);
    activeGame.bullets.forEach((bullet) => {
      ctx.fillStyle = "#ffe09a";
      ctx.shadowColor = "#f4b840";
      ctx.shadowBlur = 12;
      ctx.fillRect(bullet.x - 3, bullet.y - 7, 6, 14);
      ctx.shadowBlur = 0;
    });
    activeGame.fragments.forEach((fragment) => {
      ctx.globalAlpha = Math.max(0, fragment.life);
      ctx.fillStyle = fragment.color;
      ctx.fillRect(fragment.x, fragment.y, fragment.size, fragment.size);
      fragment.x += fragment.vx * 0.015;
      fragment.y += fragment.vy * 0.015;
      fragment.life -= 0.035;
    });
    ctx.globalAlpha = 1;
    activeGame.fragments = activeGame.fragments.filter((fragment) => fragment.life > 0);
  }

  function drawTarget(target) {
    ctx.save();
    ctx.fillStyle = target.good ? "#51c4ad" : "#f28a69";
    ctx.strokeStyle = target.good ? "#a5f2d9" : "#ffd0bd";
    ctx.lineWidth = 2;
    ctx.shadowColor = target.good ? "#2dc7a5" : "#ed6a4e";
    ctx.shadowBlur = 13;
    ctx.beginPath();
    ctx.arc(target.x, target.y, target.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.fillStyle = "#09203d";
    ctx.font = `800 ${Math.max(9, Math.min(12, target.radius * 0.35))}px "Plus Jakarta Sans", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(target.label, target.x, target.y, target.radius * 1.6);
    ctx.restore();
  }

  function drawBasket(width, height) {
    const x = activeGame.playerX;
    ctx.fillStyle = "#f0ca6c";
    ctx.strokeStyle = "#fff0bc";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 40, height - 40);
    ctx.lineTo(x - 32, height - 12);
    ctx.lineTo(x + 32, height - 12);
    ctx.lineTo(x + 40, height - 40);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  function drawShooter(width, height) {
    const x = activeGame.playerX || width / 2;
    ctx.fillStyle = "#7de0ce";
    ctx.beginPath();
    ctx.moveTo(x, height - 62);
    ctx.lineTo(x - 25, height - 22);
    ctx.lineTo(x + 25, height - 22);
    ctx.closePath();
    ctx.fill();
  }

  function resolveTarget(target, correct, effect) {
    if (activeGame.outOfLives) return;
    if (correct) {
      activeGame.combo++;
      activeGame.correct++;
      activeGame.score += 10 + Math.min(10, Math.max(0, activeGame.combo - 1));
      const effect = activeGame.combo >= 5 && activeGame.combo % 5 === 0
        ? "bonus" : activeGame.combo >= 3 && activeGame.combo % 3 === 0 ? "combo" : "score";
      playAudioEffect(effect, activeGame.key);
      document.getElementById("combo-message").textContent =
        activeGame.combo >= 3 ? `COMBO x${activeGame.combo}!` : "";
    } else {
      activeGame.combo = 0;
      activeGame.lives = Math.max(0, activeGame.lives - 1);
      if (activeGame.lives === 0) finishGame(false);
      else playAudioEffect("lifeLost", activeGame.key);
      document.getElementById("combo-message").textContent = effect === "shooter"
        ? "Jangan tembak transaksi aman!" : "Waspada, itu bukan target aman!";
    }
    if (effect === "slice" || effect === "shooter") {
      for (let i = 0; i < 7; i++) activeGame.fragments.push({
        x: target.x, y: target.y, vx: (Math.random() - 0.5) * 160,
        vy: (Math.random() - 0.5) * 160, life: 1,
        color: effect === "shooter" ? "#ffd078" : correct ? "#9af2d4" : "#ff9b80",
        size: 3 + Math.random() * 5
      });
    }
    if (activeGame.lives === 0) {
      activeGame.outOfLives = true;
      document.getElementById("combo-message").textContent = "Nyawa habis — tunggu game berikutnya.";
      submitScore(true);
    } else {
      submitScore(false);
    }
  }

  function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1; const dy = y2 - y1;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / length)) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function handlePointerDown(event) {
    if (!activeGame || activeGame.outOfLives || roomState?.status !== "running") return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(event);
    pointer = { ...point, lastX: point.x, lastY: point.y, down: true };
    activeGame.playerX = point.x;
    if (activeGame.key === "slice") sliceAt(point.x, point.y);
    if (activeGame.key === "shooter") fireAt(point.x);
  }

  function handlePointerMove(event) {
    if (!activeGame || !pointer.down) return;
    event.preventDefault();
    const point = canvasPoint(event);
    activeGame.playerX = point.x;
    if (activeGame.key === "slice") {
      activeGame.targets = activeGame.targets.filter((target) => {
        if (distanceToSegment(target.x, target.y, pointer.lastX, pointer.lastY, point.x, point.y) <
            target.radius * 0.75) {
          resolveTarget(target, target.good, "slice");
          return false;
        }
        return true;
      });
    }
    pointer.lastX = point.x;
    pointer.lastY = point.y;
  }

  function handlePointerUp() {
    pointer.down = false;
  }

  function sliceAt(x, y) {
    activeGame.targets = activeGame.targets.filter((target) => {
      if (Math.hypot(target.x - x, target.y - y) < target.radius) {
        resolveTarget(target, target.good, "slice");
        return false;
      }
      return true;
    });
  }

  function fireAt(x) {
    activeGame.bullets.push({ x, y: activeGame.height - 45, vy: -470 });
  }

  function updateWhack(now, remaining) {
    if (now - lastWhackTime > (roomState.difficulty === "hard" ? 570 : 900)) {
      lastWhackTime = now;
      whackIndex = Math.floor(Math.random() * 9);
      const safe = Math.random() < 0.28;
      const button = whackBoard.children[whackIndex];
      button.dataset.safe = String(safe);
      button.dataset.active = "true";
      button.dataset.targetToken = `${now}-${Math.random()}`;
      button.textContent = safe
        ? SAFE_ITEMS[Math.floor(Math.random() * SAFE_ITEMS.length)]
        : FRAUD_ITEMS[Math.floor(Math.random() * FRAUD_ITEMS.length)];
      button.classList.toggle("safe", safe);
      button.classList.add("active");
      button.setAttribute("aria-label", `${button.textContent}, ${safe ? "tindakan aman" : "modus penipuan"}`);
      const targetToken = button.dataset.targetToken;
      window.setTimeout(() => {
        if (button.dataset.active === "true" && button.dataset.targetToken === targetToken) clearWhack(button);
      }, Math.min(850, remaining));
    }
  }

  function clearWhack(button) {
    button.dataset.active = "false";
    button.textContent = "—";
    button.classList.remove("active", "safe");
    button.setAttribute("aria-label", "Lubang kosong");
  }

  function whack(index) {
    const button = whackBoard.children[index];
    if (!activeGame || !button || button.dataset.active !== "true" || activeGame.outOfLives) return;
    const safe = button.dataset.safe === "true";
    clearWhack(button);
    if (safe) resolveTarget({ good: false }, false, "whack");
    else resolveTarget({ good: true }, true, "whack");
  }

  function updateBomb(elapsed, remaining) {
    const step = Math.floor(elapsed / 8000);
    if (step !== bombStep && remaining > 0) {
      bombStep = step;
      bombAnsweredStep = -1;
      const scenario = SCENARIOS[step % SCENARIOS.length];
      document.getElementById("bomb-scenario").textContent = scenario.prompt;
      document.getElementById("bomb-feedback").textContent = "";
      const choices = document.getElementById("bomb-choices");
      choices.replaceChildren();
      scenario.options.forEach((label, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => answerBomb(step, index));
        choices.append(button);
      });
    }
    const localRemaining = 8 - (elapsed / 1000 % 8);
    document.getElementById("game-timer").textContent = `${formatClock(Math.ceil(remaining / 1000))} • ${Math.ceil(localRemaining)}s`;
    if (localRemaining <= 0.1 && bombAnsweredStep !== step) {
      bombAnsweredStep = step;
      document.getElementById("bomb-feedback").textContent = "💥 Waktu habis! Ingat, jangan bagikan OTP.";
      resolveTarget({ good: false }, false, "bomb");
    }
  }

  function answerBomb(step, choice) {
    if (!activeGame || activeGame.outOfLives || bombAnsweredStep === step) return;
    bombAnsweredStep = step;
    const scenario = SCENARIOS[step % SCENARIOS.length];
    const feedback = document.getElementById("bomb-feedback");
    document.querySelectorAll("#bomb-choices button").forEach((button) => { button.disabled = true; });
    if (choice === scenario.correct) {
      feedback.textContent = `✅ ${scenario.note}`;
      resolveTarget({ good: true }, true, "bomb");
    } else {
      feedback.textContent = `💥 Pilihan kurang aman. ${scenario.note}`;
      resolveTarget({ good: false }, false, "bomb");
    }
  }

  function updateScoreDisplay() {
    if (!activeGame) return;
    document.getElementById("player-score").textContent = `${activeGame.score} poin`;
    document.getElementById("player-lives").textContent = `Nyawa ${activeGame.lives}`;
  }

  function submitScore(force) {
    if (!activeGame || !playerCredentials || !roomState || !GAME_KEYS.includes(activeGame.key)) return Promise.resolve();
    const payload = {
      p_room_id: playerCredentials.roomId,
      p_participant_id: playerCredentials.participantId,
      p_participant_token: playerCredentials.participantToken,
      p_game_key: activeGame.key,
      p_score: activeGame.score,
      p_correct_actions: activeGame.correct,
      p_elapsed_ms: Math.min(roomState.game_duration_seconds * 1000 + 10000,
        Math.max(0, activeGame.elapsedMs || 0))
    };
    const stamp = `${payload.p_game_key}:${payload.p_score}:${payload.p_correct_actions}:${payload.p_elapsed_ms}`;
    if (stamp === lastScoreSent) return Promise.resolve();
    if (!force) {
      if (scoreTimer) return Promise.resolve();
      scoreTimer = window.setTimeout(() => {
        scoreTimer = null;
        submitScore(true);
      }, 3500);
      return Promise.resolve();
    }
    if (scoreTimer) window.clearTimeout(scoreTimer);
    scoreTimer = null;
    lastScoreSent = stamp;
    return rpc("submit_peka_arcade_score", payload)
      .then(updateScoreDisplay)
      .catch((error) => {
        lastScoreSent = "";
        setStatus(normalizeRpcError(error), "error");
      });
  }

  function bindEvents() {
    bindAudioControls();
    adminForm.addEventListener("submit", signInAdmin);
    joinForm.addEventListener("submit", joinRoom);
    document.getElementById("create-room").addEventListener("click", createRoom);
    document.getElementById("admin-signout").addEventListener("click", signOutAdmin);
    document.getElementById("admin-start").addEventListener("click", () => adminAction("start"));
    document.getElementById("admin-pause").addEventListener("click", () => adminAction("pause"));
    document.getElementById("admin-resume").addEventListener("click", () => adminAction("resume"));
    document.getElementById("admin-next").addEventListener("click", () => adminAction("next"));
    document.getElementById("admin-finish").addEventListener("click", () => adminAction("finish"));
    document.getElementById("admin-close").addEventListener("click", () => adminAction("close"));
    document.getElementById("export-csv").addEventListener("click", exportCsv);
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerUp);
    window.addEventListener("resize", configureCanvas);
    window.addEventListener("pagehide", () => {
      stopGameLoop();
      stopMusic();
      cancelCountdown();
    });
    document.getElementById("join-pin").addEventListener("input", (event) => {
      event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
    });
    document.getElementById("game-order-inputs").addEventListener("change", (event) => {
      if (event.target.matches("select") && adminRoomId && roomState?.status === "lobby") {
        adminAction("configure");
      }
    });
  }

  async function initialize() {
    setupGameOrder();
    bindEvents();
    const pinFromUrl = new URLSearchParams(location.search).get("pin");
    if (pinFromUrl && /^\d{6}$/.test(pinFromUrl)) {
      document.getElementById("join-pin").value = pinFromUrl;
      document.getElementById("join-name").focus();
    }
    if (!validConfig || !supabaseClient) {
      setStatus(!window.supabase?.createClient
        ? "Pustaka Supabase tidak dapat dimuat. Periksa jaringan, lalu muat ulang halaman."
        : "Konfigurasi Supabase belum valid; room dan skor belum dapat digunakan.", "error");
      document.querySelectorAll("button, input").forEach((element) => {
        if (!element.closest(".audio-controls")) element.disabled = true;
      });
      return;
    }
    try {
      if (playerCredentials?.roomId && await enterPlayerRoom()) {
        setStatus("Anda kembali ke room. Menunggu permainan atau melanjutkan sesi yang berjalan.", "success");
        return;
      }
      await restoreAdmin();
      if (!adminUser) {
        setStatus("Konfigurasi Supabase ditemukan. Pastikan migration arcade diterapkan pada project ini sebelum membuat room.");
      }
    } catch (error) {
      if (/room_access_denied|room_not_found/.test(error.message)) {
        sessionStorage.removeItem(playerStorage);
        playerCredentials = null;
      }
      showPanel(entryPanel);
      setStatus(normalizeRpcError(error), "error");
    }
  }

  initialize();
})();
