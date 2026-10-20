begin;

do $preflight$
begin
  if to_regclass('public.peka_participants') is null
     or to_regclass('public.peka_questions') is null
     or to_regclass('public.peka_quiz_sessions') is null
     or to_regclass('public.peka_answers') is null then
    raise exception 'Required PeKA tables are missing; inspect migration history before applying this migration.';
  end if;

  if not exists (
    select 1
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = 'peka_participants'
       and c.column_name = 'auth_user_id'
       and c.data_type = 'uuid'
       and c.is_nullable = 'YES'
  ) then
    raise exception 'Migration 003 must be applied before this migration: peka_participants.auth_user_id must be nullable.';
  end if;

  if to_regprocedure(
       'public.advance_peka_quiz(uuid,uuid,text,smallint,smallint)'
     ) is null then
    raise exception 'Expected public.advance_peka_quiz(uuid,uuid,text,smallint,smallint); inspect migration history before applying this migration.';
  end if;

  if exists (
    select 1
      from (
        values
          ('id', 'smallint'),
          ('question_order', 'smallint'),
          ('question_text', 'text'),
          ('options', 'jsonb'),
          ('timer_seconds', 'smallint'),
          ('is_active', 'boolean'),
          ('answer_key', 'smallint'),
          ('answer_key_verified', 'boolean')
      ) expected(column_name, data_type)
      left join information_schema.columns actual
        on actual.table_schema = 'public'
       and actual.table_name = 'peka_questions'
       and actual.column_name = expected.column_name
     where actual.column_name is null
        or actual.data_type <> expected.data_type
  ) then
    raise exception 'public.peka_questions is missing required columns or has incompatible types.';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.peka_questions'::regclass
       and c.contype = 'p'
       and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
  ) or not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.peka_questions'::regclass
       and c.contype = 'u'
       and pg_get_constraintdef(c.oid) = 'UNIQUE (question_order)'
  ) then
    raise exception 'public.peka_questions must retain its primary key on id and unique question_order constraint.';
  end if;
end;
$preflight$;

create or replace function private.is_valid_peka_question_sequence(p_sequence smallint[])
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(
    array_ndims(p_sequence) = 1
    and array_lower(p_sequence, 1) = 1
    and array_upper(p_sequence, 1) = 30
    and cardinality(p_sequence) = 30
    and (
      select count(question_id) = 30 and min(question_id) = 1 and max(question_id) = 30
        from (select distinct unnest(p_sequence) as question_id) ids
    ),
    false
  );
$$;

revoke all on function private.is_valid_peka_question_sequence(smallint[])
  from public, anon, authenticated;
grant execute on function private.is_valid_peka_question_sequence(smallint[])
  to service_role;

alter table public.peka_questions
  alter column timer_seconds set default 60;
alter table public.peka_questions
  drop constraint if exists peka_questions_timer_seconds_check;
update public.peka_questions
   set timer_seconds = 60
 where timer_seconds <> 60;
alter table public.peka_questions
  add constraint peka_questions_timer_seconds_check check (timer_seconds = 60);

alter table public.peka_quiz_sessions
  add column if not exists question_sequence smallint[] not null
  default array[
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30
  ]::smallint[];
alter table public.peka_quiz_sessions
  drop constraint if exists peka_session_question_sequence_valid;
alter table public.peka_quiz_sessions
  add constraint peka_session_question_sequence_valid
  check (private.is_valid_peka_question_sequence(question_sequence));

do $preflight$
begin
  if exists (
    select 1
      from public.peka_questions
     where id between 1 and 30
       and question_order <> id
  ) then
    raise exception 'Existing question IDs do not match question_order 1-30; refusing to remap saved answers.';
  end if;

  if exists (
    select 1
      from public.peka_questions
     where is_active
       and (id not between 1 and 30 or question_order not between 1 and 30 or id <> question_order)
  ) then
    raise exception 'Unexpected active question outside the stable 1-30 bank; refusing to create a duplicate bank.';
  end if;

  if exists (
    select 1
      from public.peka_quiz_sessions s
     where s.status = 'in_progress'
       and (
         not private.is_valid_peka_question_sequence(s.question_sequence)
         or exists (
           select 1
             from public.peka_answers a
            where a.session_id = s.id
              and not (a.question_id = any(s.question_sequence))
         )
         or s.question_sequence[s.current_question_order] is null
         or exists (
           select 1
             from public.peka_answers a
            where a.session_id = s.id
              and a.question_id = s.question_sequence[s.current_question_order]
         )
       )
  ) then
    raise exception 'An in-progress session has an invalid sequence or an answered current question; inspect session state before migrating.';
  end if;

  if exists (
    select 1
      from public.peka_quiz_sessions s
     where s.status = 'in_progress'
       and s.quiz_type = 'PRE_TEST'
       and s.question_sequence is distinct from array[
         1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
         16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30
       ]::smallint[]
  ) then
    raise exception 'An in-progress PRE_TEST does not follow document order; refusing to rewrite questions already shown.';
  end if;
end;
$preflight$;

-- Keys 19 and 30 match the displayed phishing and content-engagement questions.
insert into public.peka_questions (
  id, question_order, question_text, options, timer_seconds, is_active,
  answer_key, answer_key_verified, updated_at
)
values
  (1, 1, 'Peraturan Bank Indonesia yang menjadi acuan utama Perlindungan Konsumen Bank Indonesia adalah ...',
   jsonb_build_array('PBI Nomor 3 Tahun 2026', 'PBI Nomor 6 Tahun 2026', 'PBI Nomor 9 Tahun 2026', 'PBI Nomor 1 Tahun 2026'), 60, true, 1, true, now()),
  (2, 2, 'PBI Nomor 6 Tahun 2026 tentang Perlindungan Konsumen Bank Indonesia mulai berlaku pada tanggal ...',
   jsonb_build_array('1 Januari 2026', '24 Juni 2026', '30 Juni 2026', '30 September 2026'), 60, true, 2, true, now()),
  (3, 3, 'Seorang nasabah menerima pesan WhatsApp yang mengaku dari bank dan meminta PIN untuk membatalkan transaksi mencurigakan. Apa respons paling tepat yang perlu disampaikan Duta PeKA?',
   jsonb_build_array('Meminta nasabah membalas pesan tersebut agar identitas pengirim pesan dapat diverifikasi terlebih dahulu', 'Menyarankan nasabah tidak memberi PIN/OTP, menghubungi kanal resmi bank, dan segera melaporkan transaksi', 'Menyarankan nasabah mengirim tangkapan layar rekening dan PIN kepada petugas yang menghubunginya via pesan', 'Menyarankan nasabah menunggu 24 jam untuk melihat apakah saldo rekeningnya benar-benar berkurang atau tidak'), 60, true, 1, true, now()),
  (4, 4, 'Konsumen mengeluhkan transaksi QRIS berhasil terdebet, tetapi pedagang menyatakan pembayaran belum masuk. Langkah awal yang paling tepat adalah ...',
   jsonb_build_array('Meminta konsumen membayar ulang transaksinya agar transaksi tersebut tidak tertunda lebih lama', 'Langsung menyimpulkan bahwa penyelenggara QRIS melakukan kesalahan dalam memproses transaksi', 'Mengarahkan konsumen menyimpan bukti transaksi dan menghubungi PJP melalui kanal pengaduan resmi', 'Menyarankan konsumen mengunggah data rekening dan bukti transaksi ke media sosial pribadi miliknya'), 60, true, 2, true, now()),
  (5, 5, 'Seorang pedagang menempelkan stiker QRIS baru menutupi QRIS resmi di kasir. Konsumen menyadari nama penerima di aplikasi berbeda dari nama pedagang. Apa tindakan terbaik?',
   jsonb_build_array('Tetap membayar transaksi tersebut karena kode QR berada di lokasi kasir milik pedagang yang bersangkutan', 'Membatalkan transaksi, mengonfirmasi langsung kepada pedagang, dan melaporkan dugaan penggantian QRIS', 'Melanjutkan pembayaran dengan nominal kecil sebagai percobaan untuk memastikan kode QR tersebut aman', 'Meminta konsumen lain mencoba memindai QR tersebut untuk melihat apakah pembayaran akan berhasil'), 60, true, 1, true, now()),
  (6, 6, 'Konsumen mengirim keluhan melalui akun media sosial pribadi pegawai bank dan belum mendapat jawaban. Saran yang paling tepat adalah ...',
   jsonb_build_array('Mengirim ulang keluhan tersebut dengan menyertakan PIN dan OTP agar segera diproses oleh pegawai', 'Menunggu sampai pegawai tersebut membalas keluhan tanpa melakukan tindakan lain apa pun lagi', 'Menggunakan kanal pengaduan resmi penyelenggara serta menyimpan nomor/tanda terima pengaduan', 'Mengirim keluhan ke semua grup percakapan yang ada agar cepat ditangani oleh pihak yang terkait'), 60, true, 2, true, now()),
  (7, 7, 'Seorang nasabah menerima pesan WhatsApp yang mengaku dari bank dan kemudian diarahkan untuk mengamankan dananya dengan cara mentransfer seluruh dana pada tabungannya ke rekening yang diberikan oleh pihak yang mengaku dari bank tersebut. Berdasarkan kondisi tersebut, kejadian tersebut paling tepat termasuk ....',
   jsonb_build_array('Cyber dependent crime karena sistem bank pasti telah diretas', 'Cyber related crime karena penipuan konvensional dibantu media digital', 'DDoS karena penipu mengganggu layanan perbankan', 'Web defacement karena ada penyamaran identitas bank'), 60, true, 1, true, now()),
  (8, 8, 'Apa tujuan utama perlindungan konsumen dalam penyelenggaraan sistem pembayaran?',
   jsonb_build_array('Menghilangkan seluruh risiko transaksi digital agar konsumen tidak perlu lagi berhati-hati sama sekali', 'Memastikan konsumen memperoleh perlakuan adil, informasi jelas, dan mekanisme pengaduan sesuai ketentuan', 'Mengutamakan kepentingan penyelenggara agar biaya operasional tetap rendah bagi pihak penyelenggara jasa', 'Menggantikan kewajiban konsumen untuk menjaga keamanan data pribadi miliknya sendiri saat bertransaksi'), 60, true, 1, true, now()),
  (9, 9, 'Pelaku mengeksploitasi celah aplikasi website suatu bank lalu mengubah tampilan situs tanpa izin. Mengapa peristiwa ini termasuk cyber dependent crime?',
   jsonb_build_array('Karena perbuatannya menimbulkan kerugian finansial terhadap bank', 'Karena melibatkan pegawai internal dan pihak vendor', 'Karena melibatkan sistem elektronik sebagai korbannya', 'Karena perubahannya memberikan informasi baru kepada nasabah'), 60, true, 2, true, now()),
  (10, 10, 'Seorang konsumen mengaku telah memberikan OTP kepada penipu dan baru menyadari ada transaksi tidak dikenal. Tindakan yang sebaiknya diprioritaskan adalah ...',
   jsonb_build_array('Menghapus seluruh pesan percakapan dengan penipu agar konsumen tidak panik dan merasa jauh lebih tenang', 'Segera menghubungi bank/PJP via kanal resmi, mengamankan akses, melaporkan transaksi, dan menyimpan bukti', 'Menunggu laporan polisi selesai diproses terlebih dahulu sebelum menghubungi bank atau penyedia jasa resmi', 'Menghubungi nomor telepon yang diberikan oleh penipu untuk meminta pembatalan transaksi tersebut segera'), 60, true, 1, true, now()),
  (11, 11, 'Dalam menyampaikan edukasi, seorang Duta PeKA ingin menggunakan contoh kasus pengaduan nasabah. Prinsip yang harus diutamakan adalah ...',
   jsonb_build_array('Menyebut nama, nomor rekening, dan kronologi lengkap agar kasus terasa nyata bagi peserta', 'Menggunakan data pribadi jika materi hanya dibagikan di grup internal yang terbatas saja', 'Menghilangkan/menyamarkan identitas dan hanya memakai informasi yang diperlukan untuk edukasi', 'Meminta peserta menebak identitas konsumen dari kasus tersebut sebagai bahan diskusi bersama'), 60, true, 2, true, now()),
  (12, 12, 'Data identitas dan nomor rekening nasabah berhasil diakses oleh pihak tak berwenang, sementara sistem masih berjalan normal dan catatan transaksi tidak berubah. Aspek keamanan informasi yang paling langsung dilanggar adalah ....',
   jsonb_build_array('Confidentiality (kerahasiaan)', 'Integrity (integritas)', 'Availability (ketersediaan)', 'Non-repudiation (nirpenyangkalan)'), 60, true, 0, true, now()),
  (13, 13, 'Dalam pemeriksaan transaksi ditemukan bahwa nomor rekening tujuan pada data transfer berubah tanpa persetujuan nasabah. Aspek CIA yang terutama terpengaruh adalah ....',
   jsonb_build_array('Availability karena aplikasi tidak dapat dibuka', 'Confidentiality karena dokumen dibaca pihak luar', 'Availability karena data disimpan di server', 'Integrity karena data transaksi berubah tanpa otorisasi'), 60, true, 3, true, now()),
  (14, 14, 'Aplikasi mobile banking tidak dapat digunakan akibat banyaknya trafik permintaan palsu yang mengakses ke server. Dampak utama pada kerangka CIA adalah ....',
   jsonb_build_array('Hilangnya kerahasiaan PIN seluruh nasabah', 'Perubahan nominal saldo oleh nasabah', 'Terganggunya ketersediaan layanan', 'Hilangnya keaslian dokumen identitas'), 60, true, 2, true, now()),
  (15, 15, 'Konsumen hendak membayar melalui QRIS. Pemeriksaan yang paling relevan sebelum memasukkan PIN atau mengkonfirmasi pembayaran adalah ...',
   jsonb_build_array('Memastikan nama merchant/penerima dan nominal sesuai dengan transaksi', 'Memastikan kamera ponsel memiliki resolusi tinggi saat memindai kode', 'Memastikan pedagang menggunakan ponsel keluaran terbaru saat transaksi', 'Memastikan kode QR berwarna hitam putih dan tercetak dengan rapi'), 60, true, 0, true, now()),
  (16, 16, 'Apa langkah yang paling tepat jika konsumen belum puas terhadap tanggapan pengaduan dari penyelenggara jasa pembayaran?',
   jsonb_build_array('Mengancam petugas layanan melalui akun pribadi agar tanggapan pengaduan segera diperbaiki', 'Mengikuti mekanisme tindak lanjut/eskalasi yang ada dan menyimpan korespondensi serta bukti', 'Membuat laporan berulang dengan informasi yang berbeda-beda agar segera ditanggapi', 'Membagikan data sensitif di media sosial untuk menekan penyelenggara agar segera menanggapi'), 60, true, 1, true, now()),
  (17, 17, 'Pegawai bank menggunakan akun yang memang diberikan kepadanya untuk menyalin data nasabah di luar kebutuhan pekerjaannya. Kategori pelaku ancaman yang paling tepat adalah ....',
   jsonb_build_array('State-sponsored actor', 'Insider', 'Hacktivist', 'Threat Actor'), 60, true, 1, true, now()),
  (18, 18, 'Penggantian nomor telepon yang terdaftar pada rekening diproses tanpa tahapan verifikasi identitas sebagaimana seharusnya. Kelemahan utama berdasarkan pendekatan People-Process-Technology berada pada ....',
   jsonb_build_array('Process karena prosedur dan kontrol verifikasi tidak berjalan', 'Technology karena semua perangkat pasti terinfeksi malware', 'People karena nasabah selalu bertanggung jawab penuh', 'Confidentiality karena seluruh data pasti telah dipublikasikan'), 60, true, 0, true, now()),
  (19, 19, 'Seorang nasabah menerima email berlogo bank yang mengarahkan ke halaman login dengan alamat web yang tampak mirip situs resmi. Modus yang paling sesuai adalah ....',
   jsonb_build_array('Phishing melalui email dan situs tiruan', 'Vishing melalui percakapan telepon', 'DDoS terhadap server transaksi', 'Jamming jaringan nirkabel'), 60, true, 0, true, now()),
  (20, 20, 'Dalam materi edukasi, istilah ''social engineering'' paling tepat dijelaskan sebagai ...',
   jsonb_build_array('Gangguan teknis pada sistem yang membuat aplikasi menjadi lambat saat digunakan oleh para pengguna', 'Manipulasi psikologis agar korban menyerahkan informasi rahasia atau bertindak menguntungkan pelaku', 'Proses resmi verifikasi identitas nasabah yang dilakukan oleh semua bank secara rutin dan berkala', 'Metode teknis untuk meningkatkan kekuatan sinyal internet di wilayah dengan jaringan yang lemah'), 60, true, 1, true, now()),
  (21, 21, 'Konsumen ingin mengajukan pengaduan, tetapi bukti transaksi belum lengkap. Saran yang paling tepat adalah ...',
   jsonb_build_array('Tidak perlu mengadu sebelum semua bukti transaksi yang diperlukan menjadi sempurna dan lengkap dulu', 'Segera menghubungi kanal resmi untuk arahan, menyampaikan informasi tersedia, dan melengkapi bukti', 'Membuat bukti transaksi sendiri agar pengaduan yang diajukan dapat segera diterima oleh petugas layanan', 'Meminta pelaku menandatangani surat pengakuan terlebih dahulu sebelum mengajukan pengaduan resmi'), 60, true, 1, true, now()),
  (22, 22, 'Nasabah menerima SMS yang tampaknya berasal dari layanan bank, berisi tautan ''aktivasi ulang'' dan permintaan memasukkan kredensial. Jenis social engineering berbasis kanal yang paling tepat adalah ....',
   jsonb_build_array('Smishing (phishing melalui SMS)', 'Vishing (phishing melalui telepon)', 'Quishing (phishing melalui kode QR)', 'Baiting dengan USB fisik'), 60, true, 0, true, now()),
  (23, 23, 'Seseorang menelepon nasabah, mengaku petugas bank, lalu meminta PIN atau OTP dengan alasan verifikasi transaksi mencurigakan. Modus yang digunakan adalah ....',
   jsonb_build_array('Quishing', 'Vishing', 'Web defacement', 'Supply chain attack'), 60, true, 1, true, now()),
  (24, 24, 'Dalam menjelaskan aturan perlindungan konsumen, Duta PeKA belum yakin dengan ketentuan teknis tertentu. Apa tindakan yang paling profesional?',
   jsonb_build_array('Menjawab berdasarkan perkiraan pribadi agar terlihat menguasai seluruh materi tersebut', 'Mengutip unggahan media sosial tanpa memeriksa sumber informasinya terlebih dahulu', 'Memeriksa ketentuan resmi atau mengonfirmasi ke unit berwenang sebelum menjelaskan', 'Menghindari semua pertanyaan peserta agar tidak ketahuan belum menguasai materi'), 60, true, 2, true, now()),
  (25, 25, 'Mana yang TIDAK boleh muncul di konten edukasi buatan pegawai bank?',
   jsonb_build_array('Screenshot chat penipu yang identitasnya sudah disamarkan', 'Nomor kanal aduan resmi BI Bicara 131', 'Layar sistem internal yang memperlihatkan potongan nomor rekening nasabah', 'Reka adegan modus QRIS ditimpa stiker palsu'), 60, true, 2, true, now()),
  (26, 26, 'Pembuka video (3 detik pertama) mana yang paling bikin orang berhenti scroll?',
   jsonb_build_array('"Halo Sobat, pada kesempatan kali ini saya akan membahas social engineering."', '"Aku kerja di bank. Kalau ada yang ngaku dari bank terus minta OTP, itu 100% bukan kami."', '"Assalamualaikum, perkenalkan saya dari Divisi Pelindungan Konsumen."', '"Video ini berisi edukasi tentang keamanan transaksi digital."'), 60, true, 1, true, now()),
  (27, 27, 'Dalam menyampaikan edukasi PeKA kepada masyarakat, seorang Duta PeKA menemukan informasi modus penipuan yang belum terverifikasi. Tindakan yang paling tepat adalah ...',
   jsonb_build_array('Menyebarkan informasi tersebut secepatnya agar masyarakat menjadi lebih waspada terhadap modus', 'Menambahkan dugaan pribadi ke dalam materi agar edukasi menjadi lebih menarik bagi peserta', 'Memastikan informasi lewat sumber terpercaya dan tidak menyampaikan dugaan sebagai fakta', 'Mengabaikan seluruh informasi mengenai modus penipuan digital yang belum terverifikasi'), 60, true, 2, true, now()),
  (28, 28, 'Konsumen menerima notifikasi transaksi yang tidak dilakukan. Ia masih dapat membuka aplikasi. Langkah yang paling tepat adalah ...',
   jsonb_build_array('Mengabaikan notifikasi tersebut jika nominal transaksinya kecil dan dianggap tidak merugikan konsumen', 'Segera mengamankan akun sesuai panduan, menghubungi kanal resmi, melapor transaksi, dan menyimpan bukti', 'Mengirim OTP kepada petugas yang menghubungi agar transaksi tersebut segera dibatalkan oleh pihak bank', 'Menghapus aplikasi dari ponsel tanpa menghubungi penyelenggara jasa pembayaran yang terkait sama sekali'), 60, true, 1, true, now()),
  (29, 29, 'Manakah contoh pendekatan edukasi yang paling sesuai untuk Duta PeKA?',
   jsonb_build_array('Menyalahkan korban karena kurang teliti sehingga peserta lain menjadi lebih berhati-hati', 'Menggunakan istilah teknis tanpa penjelasan agar terlihat sebagai ahli di depan peserta', 'Menyesuaikan bahasa dengan audiens, memakai contoh relevan, dan memberi langkah praktis', 'Menakut-nakuti peserta agar tidak menggunakan pembayaran digital dalam kehidupan sehari-hari'), 60, true, 2, true, now()),
  (30, 30, 'Indikator mana yang paling menunjukkan konten edukasi berhasil mendorong audiens bertindak?',
   jsonb_build_array('Jumlah views', 'Jumlah likes', 'Jumlah saves dan shares', 'Jumlah followers baru'), 60, true, 2, true, now())
on conflict (id) do update
set question_order = excluded.question_order,
    question_text = excluded.question_text,
    options = excluded.options,
    timer_seconds = excluded.timer_seconds,
    is_active = excluded.is_active,
    answer_key = excluded.answer_key,
    answer_key_verified = excluded.answer_key_verified,
    updated_at = excluded.updated_at;

do $preflight$
begin
  if (
    select count(*) = 30
       and count(*) filter (
         where id between 1 and 30
           and question_order = id
           and timer_seconds = 60
           and answer_key between 0 and 3
           and answer_key_verified
           and is_active
       ) = 30
      from public.peka_questions
     where is_active
  ) is not true then
    raise exception 'The active PeKA bank must contain exactly the verified 30 questions with IDs/order 1-30 and 60-second timers.';
  end if;
end;
$preflight$;

-- Preserve persisted answers and the current item; shuffle only unseen POST_TEST items.
with session_answers as (
  select
    s.id,
    s.current_question_order,
    s.question_sequence,
    coalesce(
      array_agg(a.question_id order by array_position(s.question_sequence, a.question_id))
        filter (where a.question_id is not null),
      '{}'::smallint[]
    ) as answered_ids
  from public.peka_quiz_sessions s
  left join public.peka_answers a on a.session_id = s.id
  where s.status = 'in_progress'
    and s.quiz_type = 'POST_TEST'
  group by s.id
),
session_prefixes as (
  select
    id,
    current_question_order,
    question_sequence,
    answered_ids,
    question_sequence[current_question_order] as current_question_id,
    answered_ids || question_sequence[current_question_order] as preserved_ids
  from session_answers
)
update public.peka_quiz_sessions s
   set question_sequence =
         p.preserved_ids ||
         coalesce(
           (select array_agg(q.id::smallint order by random())
              from public.peka_questions q
             where q.is_active
               and q.id <> all(p.preserved_ids)),
           '{}'::smallint[]
         ),
       current_question_order = cardinality(p.answered_ids) + 1
  from session_prefixes p
 where s.id = p.id;

-- CREATE OR REPLACE cannot rename installed input parameters; preserve their names.
do $migration$
declare
  v_argument_names text[];
  v_arguments text;
begin
  if not exists (
    select 1
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = 'peka_participants'
       and c.column_name = 'auth_user_id'
       and c.is_nullable = 'YES'
  ) then
    raise exception 'Migration 003 identity schema must be applied before this quiz RPC migration.';
  end if;

  select array[
    coalesce(p.proargnames[1], 'p_session_id'),
    coalesce(p.proargnames[2], 'p_participant_id'),
    coalesce(p.proargnames[3], 'p_action'),
    coalesce(p.proargnames[4], 'p_question_order'),
    coalesce(p.proargnames[5], 'p_selected_option')
  ]
    into v_argument_names
    from pg_catalog.pg_proc p
   where p.oid = to_regprocedure(
     'public.advance_peka_quiz(uuid,uuid,text,smallint,smallint)'
   );

  if not found then
    raise exception 'Expected public.advance_peka_quiz(uuid,uuid,text,smallint,smallint) after migrations 001-003.';
  end if;

  v_arguments := format(
    '%I uuid, %I uuid, %I text, %I smallint default null, %I smallint default null',
    v_argument_names[1],
    v_argument_names[2],
    v_argument_names[3],
    v_argument_names[4],
    v_argument_names[5]
  );

  execute format($ddl$
create or replace function public.advance_peka_quiz(%s)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $body$
declare
  v_session public.peka_quiz_sessions%rowtype;
  v_question public.peka_questions%rowtype;
  v_now timestamptz;
  v_expired boolean;
  v_selected smallint;
  v_answer_count bigint;
begin
  if $3 not in ('current', 'answer') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if $3 = 'answer'
     and ($4 is null or
          ($5 is not null and $5 not between 0 and 3)) then
    raise exception 'invalid_answer' using errcode = '22023';
  end if;

  select s.*
    into v_session
    from public.peka_quiz_sessions s
    where s.id = $1
      and s.participant_id = $2
   for update;
  if not found then
    raise exception 'session_not_found' using errcode = '42501';
  end if;

  v_now := clock_timestamp();
  if v_session.status = 'completed' then
    select count(*)
      into v_answer_count
      from public.peka_answers a
     where a.session_id = v_session.id;
    if v_session.current_question_order <> 31 or v_answer_count <> 30 then
      raise exception 'completed_session_incomplete' using errcode = '23514';
    end if;
    return jsonb_build_object('completed', true);
  end if;

  if not private.is_valid_peka_question_sequence(v_session.question_sequence) then
    raise exception 'invalid_question_sequence' using errcode = '23514';
  end if;
  v_expired := v_now >= v_session.question_started_at + interval '60 seconds';

  if $3 = 'current' and not v_expired then
    select q.*
      into v_question
      from public.peka_questions q
     where q.id = v_session.question_sequence[v_session.current_question_order]
       and q.is_active;
    if not found then
      raise exception 'active_question_not_found' using errcode = 'P0002';
    end if;
    return jsonb_build_object(
      'completed', false,
      'question', jsonb_build_object(
        'id', v_question.id,
        'order', v_session.current_question_order,
        'question', v_question.question_text,
        'options', v_question.options
      ),
      'seconds_remaining', greatest(
        1,
        ceil(extract(epoch from (
          v_session.question_started_at + interval '60 seconds' - v_now
        )))::integer
      )
    );
  end if;

  if $3 = 'answer' and $4 <> v_session.current_question_order then
    raise exception 'stale_question' using errcode = '40001';
  end if;
  if $3 = 'answer' and not v_expired and $5 is null then
    raise exception 'timer_not_expired' using errcode = '22023';
  end if;

  select q.*
    into v_question
    from public.peka_questions q
   where q.id = v_session.question_sequence[v_session.current_question_order]
     and q.is_active;
  if not found then
    raise exception 'active_question_not_found' using errcode = 'P0002';
  end if;

  v_selected := case
    when $3 = 'answer' and not v_expired then $5
    else null
  end;

  insert into public.peka_answers (
    session_id, question_id, selected_option, is_correct, timed_out, answered_at
  ) values (
    v_session.id,
    v_question.id,
    v_selected,
    case when v_selected is not null
      then v_selected = v_question.answer_key
      else null
    end,
    v_selected is null,
    v_now
  );

  if v_session.current_question_order = 30 then
    update public.peka_quiz_sessions
       set current_question_order = 31,
           status = 'completed',
           completed_at = v_now
     where id = v_session.id;
    return jsonb_build_object(
      'completed', true,
      'answer_timed_out', v_selected is null,
      'feedback', case
        when v_selected is not null
          then jsonb_build_object('is_correct', v_selected = v_question.answer_key)
        else null
      end
    );
  end if;

  update public.peka_quiz_sessions
     set current_question_order = current_question_order + 1,
         question_started_at = v_now
   where id = v_session.id
   returning * into v_session;

  select q.*
    into v_question
    from public.peka_questions q
   where q.id = v_session.question_sequence[v_session.current_question_order]
     and q.is_active;
  if not found then
    raise exception 'active_question_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'completed', false,
    'answer_timed_out', v_selected is null,
    'feedback', case
      when v_selected is not null
        then jsonb_build_object('is_correct', v_selected = (
          select answer_key
            from public.peka_questions
           where id = v_session.question_sequence[v_session.current_question_order - 1]
        ))
      else null
    end,
    'question', jsonb_build_object(
      'id', v_question.id,
      'order', v_session.current_question_order,
      'question', v_question.question_text,
      'options', v_question.options
    ),
    'seconds_remaining', greatest(
      1,
      ceil(extract(epoch from (
        v_session.question_started_at + interval '60 seconds' - clock_timestamp()
      )))::integer
    )
  );
end;
$body$;
$ddl$, v_arguments);
end;
$migration$;

do $migration$
declare
  v_argument_names text[];
  v_arguments text;
begin
  select p.proargnames
    into v_argument_names
    from pg_catalog.pg_proc p
   where p.oid = to_regprocedure(
     'public.advance_peka_quiz_v2(uuid,uuid,text,smallint,smallint)'
   );

  if found and v_argument_names is distinct from array[
    'p_session_id', 'p_participant_id', 'p_action',
    'p_question_order', 'p_selected_option'
  ]::text[] then
    raise exception 'Existing advance_peka_quiz_v2 has different parameter names; inspect it before replacing the RPC contract.';
  end if;

  if not found then
    v_argument_names := array[
      'p_session_id', 'p_participant_id', 'p_action',
      'p_question_order', 'p_selected_option'
    ]::text[];
  end if;

  v_arguments := format(
    '%I uuid, %I uuid, %I text, %I smallint default null, %I smallint default null',
    v_argument_names[1],
    v_argument_names[2],
    v_argument_names[3],
    v_argument_names[4],
    v_argument_names[5]
  );

  execute format($ddl$
create or replace function public.advance_peka_quiz_v2(%s)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $body$
  select public.advance_peka_quiz($1, $2, $3, $4, $5);
$body$;
$ddl$, v_arguments);
end;
$migration$;

revoke all on function public.advance_peka_quiz(uuid, uuid, text, smallint, smallint)
  from public, anon, authenticated;
grant execute on function public.advance_peka_quiz(uuid, uuid, text, smallint, smallint)
  to service_role;
revoke all on function public.advance_peka_quiz_v2(uuid, uuid, text, smallint, smallint)
  from public, anon, authenticated;
grant execute on function public.advance_peka_quiz_v2(uuid, uuid, text, smallint, smallint)
  to service_role;

commit;
