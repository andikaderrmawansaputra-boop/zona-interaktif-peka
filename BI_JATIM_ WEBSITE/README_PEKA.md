# Zona Interaktif PeKA

## Perilaku peserta

- Peserta memilih PRE_TEST atau POST_TEST, mengisi nama, email, dan lembaga, lalu mengonfirmasi ringkasan identitas sebelum tes dimulai.
- Peserta tidak menggunakan Supabase Auth/OTP. Email adalah identitas yang dinyatakan sendiri dan **tidak diverifikasi sebagai bukti kepemilikan alamat**.
- Setiap email yang dinormalisasi hanya memiliki satu sesi untuk masing-masing jenis tes. Uniknya ditegakkan oleh indeks email dan constraint `(participant_id, quiz_type)` di database, bukan browser atau localStorage.
- PRE_TEST menampilkan 30 soal berdasarkan urutan dokumen; setiap sesi POST_TEST baru menyimpan urutan acak server-side. Kedua tes menggunakan ID soal dan bank jawaban yang sama.
- Setiap soal mendapat 60 detik yang dihitung dan divalidasi oleh database. Refresh memulihkan soal dan sisa waktu dari server; timeout dicatat sebagai tidak dijawab, sedangkan jawaban yang datang setelah deadline ditolak.
- Server menyimpan jawaban atau timeout dengan ID soal; kunci database menghitung kebenaran tanpa bergantung pada urutan tampilan. Laporan admin hanya memberi nilai final setelah 30 jawaban tercatat.
- Kunci nomor 19 adalah A (phishing melalui email dan situs tiruan), dan nomor 30 adalah C (jumlah saves dan shares). Keduanya dipetakan dengan indeks opsi 0-based di database dan ID soal stabil; laporan admin menampilkan kunci tersebut.
- Setelah sesi selesai, outbox database mengantrekan email konfirmasi. Resend harus menerima permintaan sebelum status ditandai `accepted`; ini bukan bukti email telah masuk ke inbox.
- Retry memakai outbox dan idempotency key Resend, maksimal lima percobaan. Peserta dapat meminta retry dari layar selesai setelah jeda retry. Refresh/permintaan berulang tidak membuat email baru setelah status diterima.
- Login admin memakai email/password Supabase Auth. Server tetap mewajibkan email terverifikasi dan `app_metadata.peka_admin === true`; login saja tidak memberikan akses laporan.

## Batasan identitas tanpa OTP

Karena peserta tidak membuktikan kepemilikan email, siapa pun yang mengetahui alamat peserta dapat mengetik identitas tersebut. Database tetap mencegah percobaan kedua pada email/jenis tes yang sama, tetapi tidak dapat memastikan orang yang mengisi adalah pemilik alamat. Nama/lembaga dari pendaftaran pertama menjadi data peserta yang digunakan untuk laporan dan email. Sampaikan batasan ini sebelum memakai tes untuk penilaian resmi atau data sensitif.

## Supabase dan deployment

Project yang dituju adalah `znyxujyebrcaqhgdeabm`; URL dan publishable key frontend ada di `zona-peka-config.js`. Jangan menaruh service-role key, Resend API key, atau dispatch secret di frontend atau repository.

1. Sebelum menerapkan migration, jalankan `npx supabase migration list --linked` dan periksa seluruh migration lokal yang masih pending serta project ref yang terhubung. Migration 001–003 mempertahankan nama argumen `advance_peka_quiz` yang sudah terpasang saat mengganti implementasinya; migration 003 tidak menghapus fungsi. Migration 001/002 juga berhenti jika mendeteksi skema identitas yang tidak sesuai urutan. Perubahan pada migration yang sudah tercatat tidak diterapkan ulang oleh Supabase, jadi cocokkan status remote dan skema sebelum bertindak.
2. Jalankan query baca-saja `supabase/verify_peka_migration_003.sql` dan `supabase/verify_peka_quiz_migration_004.sql` di SQL Editor pada project yang benar. Periksa signature fungsi, definisi, hak akses, konflik data, serta agregat sesi/jawaban sebelum memilih langkah deployment. Jangan membagikan hasil yang berisi data peserta.
   Jika daftar migration remote menunjukkan versi pending/kosong sementara tabel atau fungsi PeKA sudah ada, hentikan proses. Jangan langsung menjalankan `db push`, menghapus objek, atau mengubah catatan migration; cocokkan skema aktual dan catatan deployment terlebih dahulu.
3. Migration `202610190001_peka_quiz_timer_shuffle_and_keys.sql` ditujukan setelah schema 001–003. Ia mempertahankan nama argumen live untuk `advance_peka_quiz`, sedangkan `advance_peka_quiz_v2` menyediakan nama argumen stabil bagi Edge Function. Timer server ditetapkan ke 60 detik. Migrasi menjaga soal aktif saat ini dan timestamp timer sesi POST_TEST yang sedang berjalan, lalu mengacak hanya soal yang belum dikerjakan. Urutan tetap berupa ID soal dan tidak mengubah pasangan jawaban/kunci.
4. Hanya setelah migration tertunda, signature live, dan project link sudah diverifikasi, terapkan migration baru:

   ```powershell
   npx supabase migration list --linked
   npx supabase db push --linked --dry-run --skip-vault
   ```

   Tinjau daftar dan dry-run terlebih dahulu; jangan jalankan `db push` tanpa persetujuan dan pemeriksaan konsistensi status/skema. Jika memakai SQL Editor, jalankan hanya migration yang belum diterapkan setelah memeriksa backup dan status skema. Jangan menandai migration lama sebagai diterapkan atau menghapus fungsi untuk melewati error signature. File `supabase/seed-peka-questions.mjs` adalah alat sinkronisasi opsional; jalankan hanya setelah migration baru sukses dan target Supabase terverifikasi.
5. Atur Supabase Edge Function Secrets melalui Dashboard atau jalur rahasia organisasi:
   - `PEKA_SERVICE_ROLE_KEY` — gunakan secret server yang telah ada; jangan menyalinnya ke frontend.
   - `RESEND_API_KEY` — API key Resend.
   - `PEKA_EMAIL_FROM` — misalnya `Bank Indonesia Jawa Timur <alamat-terverifikasi@domain>`; domain/sender wajib diverifikasi di Resend.
   - `PEKA_EMAIL_DISPATCH_SECRET` — nilai acak panjang yang sama untuk `quiz-session` dan `quiz-completion-email`.

   Jangan simpan nilai sebenarnya di repository, file frontend, terminal log yang dibagikan, atau chat. Supabase menyediakan `SUPABASE_URL` bagi Edge Functions.

6. Deploy versi yang cocok dengan migration:

   ```powershell
   supabase functions deploy quiz-session
   supabase functions deploy quiz-completion-email
   supabase functions deploy quiz-admin-report
   ```

   `quiz-session` dan `quiz-completion-email` menggunakan `verify_jwt = false` karena endpoint peserta publik/timbal balik server-ke-server. Quiz session hanya memproses input terbatas dan mengakses database melalui server-side service key; email function juga mewajibkan dispatch secret server-ke-server. Akses tabel tetap dicabut dari `anon` dan `authenticated`, RLS tetap aktif, dan RPC database hanya diberikan ke `service_role`. Jangan pernah memasukkan service-role key ke browser.
7. Email otomatis belum aktif sampai migration, ketiga function, dan empat secrets terpasang di project hosted. `accepted` berarti API Resend menerima permintaan, bukan jaminan pengantaran.

### Memberikan role admin PeKA satu akun

Gunakan skrip lokal satu kali `supabase/grant-peka-admin.mjs`. Skrip mengambil `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` dari environment proses lokal, membaca akun melalui Supabase Auth Admin API, lalu hanya dapat mengubah akun yang email dan UUID-nya sama persis dengan target yang diberikan serta emailnya sudah terverifikasi. Mode default hanya preview; perubahan memerlukan `--apply` dan konfirmasi email interaktif. Skrip mempertahankan metadata aplikasi lain.

1. Di Supabase Dashboard → Authentication → Users, verifikasi email akun target dan salin UUID akun. Jangan mengandalkan email saja jika identitas akun belum dipastikan.
2. Setelah meninjau skrip, buka PowerShell lokal tepercaya dan atur `SUPABASE_URL` serta `SUPABASE_SERVICE_ROLE_KEY` untuk proses tersebut. Ambil key dari Supabase Dashboard → Project Settings → API; jangan memasukkannya ke file frontend, perintah yang dibagikan, atau repository. `.env` diabaikan oleh Git, tetapi skrip ini tidak membaca file `.env`.
3. Jalankan preview dengan email dan UUID target:

   ```powershell
   node .\supabase\grant-peka-admin.mjs --email admin@example.com --user-id 00000000-0000-4000-8000-000000000000
   ```

   Periksa bahwa akun yang tercetak adalah akun yang dimaksud dan emailnya terverifikasi. Perintah ini tidak mengubah metadata.
4. Hanya setelah target disetujui, ulangi perintah dengan `--apply`. Skrip akan meminta email target diketik ulang, menetapkan hanya `app_metadata.peka_admin=true`, lalu membaca ulang akun untuk verifikasi. Jangan jalankan perintah ini sampai identitas target ditinjau dan dikonfirmasi.
5. Logout lalu login ulang pada dashboard admin. Edge Function `quiz-admin-report` tetap memeriksa email terverifikasi dan `app_metadata.peka_admin === true`; tidak ada perubahan pada RLS atau data kuis.

Jangan menjalankan skrip pada project hosted yang salah. Tidak ada role yang diberikan oleh penambahan skrip ini; jalankan hanya setelah target dan URL project diverifikasi.

## Pengujian staging

Gunakan project non-produksi dan alamat uji yang dikendalikan tim. Jangan mengirim email produksi atau data pribadi nyata sebelum pemberitahuan privasi/retensi disiapkan.

1. Pastikan halaman peserta tidak memiliki alur OTP/Auth dan login admin menggunakan email/password; pastikan hanya admin yang memenuhi pemeriksaan role dapat membuka laporan.
2. Untuk PRE_TEST, pastikan urutannya 1–30, penghitung mulai dari `01:00`, turun setiap detik, dan kembali ke `01:00` saat soal berikutnya tampil. Jawab sebagian dan biarkan sebagian timeout; pastikan tepat 30 ID soal unik tersimpan, timeout tidak mendapat poin, dan status selesai hanya muncul setelah server menyatakan `completed`.
3. Ulangi untuk POST_TEST. Catat `question_sequence` sesi baru dan pastikan berisi permutasi 30 ID; periksa pilihan/kunci tetap terkait dengan ID soal, bukan urutan tampilan. Pastikan refresh memulihkan posisi dan sisa waktu server, jawaban lewat deadline ditolak, dan percobaan submit ganda tidak membuat baris jawaban kedua.
4. Coba dua permintaan start serentak untuk email dan jenis tes yang sama; pastikan hanya ada satu sesi.
5. Untuk menguji timeout tanpa menunggu 60 detik berulang kali, gunakan staging dan ubah `question_started_at` sesi uji ke waktu lebih dari 60 detik yang lalu; jangan jalankan manipulasi ini di produksi. Periksa jawaban timeout hanya tercatat sekali dan sesi berpindah otomatis saat klien meminta status.
6. Periksa laporan admin: jumlah soal 30, nilai dari kolom kunci per ID, serta peringatan ketidaksesuaian nomor 19/30 terlihat. Periksa RLS dan privilege: role `anon`/`authenticated` tidak dapat membaca atau menulis tabel peserta, sesi, jawaban, atau outbox; admin tetap harus login dan lolos pemeriksaan `peka_admin`.
7. Simulasikan Resend menerima permintaan: status outbox menjadi `accepted`, email memuat nama dan jenis tes tanpa nilai/sertifikat, dan `provider_message_id` tersimpan. Ulangi request/refresh dan pastikan provider idempotency serta outbox mencegah pengiriman ulang.
8. Simulasikan API key salah, sender belum terverifikasi, respons non-2xx, timeout, dan status database gagal diperbarui. Jawaban/sesi yang sudah tersimpan harus tetap `completed`; status email tetap dapat di-retry dengan idempotency key yang sama. Coba retry sebelum/sesudah `next_attempt_at` dan setelah batas lima percobaan.
9. Verifikasi di dashboard admin pencarian, pagination, CSV, statistik/progres, status email, skor final, dan peringatan kunci nomor 19/30.

Pemeriksaan lokal atau mock tidak membuktikan migration, RLS, otorisasi admin, penyimpanan live, atau pengiriman Resend di project hosted. Catat hasil pengujian hosted dan provider secara terpisah sebelum menyatakan email produksi aktif.
