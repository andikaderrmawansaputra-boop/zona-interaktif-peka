begin;

do $preflight$
begin
  if to_regclass('public.peka_questions') is null
     or to_regclass('public.peka_quiz_sessions') is null
     or to_regclass('public.peka_answers') is null then
    raise exception 'Required PeKA quiz tables are missing; inspect the deployed schema before applying the 15-question bank.';
  end if;

  if to_regprocedure('public.advance_peka_quiz(uuid,uuid,text,smallint,smallint)') is null then
    raise exception 'Expected public.advance_peka_quiz(uuid,uuid,text,smallint,smallint); inspect migration history before applying the 15-question bank.';
  end if;

  if to_regprocedure('public.advance_peka_quiz_v2(uuid,uuid,text,smallint,smallint)') is not null
     and (
       select p.proargnames is distinct from array[
         'p_session_id', 'p_participant_id', 'p_action',
         'p_question_order', 'p_selected_option'
       ]::text[]
         from pg_catalog.pg_proc p
        where p.oid = to_regprocedure(
          'public.advance_peka_quiz_v2(uuid,uuid,text,smallint,smallint)'
        )
     ) then
    raise exception 'Existing advance_peka_quiz_v2 has unstable argument names; inspect its clients before replacing the RPC contract.';
  end if;

  if to_regprocedure('public.claim_peka_completion_email(uuid)') is null then
    raise exception 'Expected public.claim_peka_completion_email(uuid); inspect completion-email migration history.';
  end if;

  if exists (
    select 1
      from (
        values
          ('peka_questions', 'id', 'smallint'),
          ('peka_questions', 'question_order', 'smallint'),
          ('peka_questions', 'question_text', 'text'),
          ('peka_questions', 'options', 'jsonb'),
          ('peka_questions', 'timer_seconds', 'smallint'),
          ('peka_questions', 'is_active', 'boolean'),
          ('peka_questions', 'answer_key', 'smallint'),
          ('peka_questions', 'answer_key_verified', 'boolean'),
          ('peka_quiz_sessions', 'id', 'uuid'),
          ('peka_quiz_sessions', 'participant_id', 'uuid'),
          ('peka_quiz_sessions', 'quiz_type', 'text'),
          ('peka_quiz_sessions', 'status', 'text'),
          ('peka_quiz_sessions', 'current_question_order', 'smallint'),
          ('peka_quiz_sessions', 'question_started_at', 'timestamp with time zone'),
          ('peka_quiz_sessions', 'completed_at', 'timestamp with time zone'),
          ('peka_quiz_sessions', 'question_sequence', 'ARRAY'),
          ('peka_answers', 'session_id', 'uuid'),
          ('peka_answers', 'question_id', 'smallint'),
          ('peka_answers', 'selected_option', 'smallint'),
          ('peka_answers', 'is_correct', 'boolean'),
          ('peka_answers', 'timed_out', 'boolean'),
          ('peka_answers', 'answered_at', 'timestamp with time zone'),
          ('peka_participants', 'id', 'uuid'),
          ('peka_participants', 'full_name', 'text'),
          ('peka_participants', 'email', 'text'),
          ('peka_completion_emails', 'id', 'uuid'),
          ('peka_completion_emails', 'session_id', 'uuid'),
          ('peka_completion_emails', 'status', 'text'),
          ('peka_completion_emails', 'attempt_count', 'smallint'),
          ('peka_completion_emails', 'next_attempt_at', 'timestamp with time zone'),
          ('peka_completion_emails', 'locked_until', 'timestamp with time zone')
      ) expected(table_name, column_name, data_type)
      left join information_schema.columns actual
        on actual.table_schema = 'public'
       and actual.table_name = expected.table_name
       and actual.column_name = expected.column_name
     where actual.column_name is null
        or actual.data_type <> expected.data_type
  ) then
    raise exception 'A required PeKA table column is missing or has an incompatible type; inspect the live schema before applying this migration.';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.peka_quiz_sessions'::regclass
       and c.contype = 'u'
       and pg_get_constraintdef(c.oid) = 'UNIQUE (participant_id, quiz_type)'
  ) or not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.peka_quiz_sessions'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%PRE_TEST%'
       and pg_get_constraintdef(c.oid) like '%POST_TEST%'
  ) or not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.peka_quiz_sessions'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%in_progress%'
       and pg_get_constraintdef(c.oid) like '%completed%'
  ) then
    raise exception 'Quiz session uniqueness/type/status constraints do not match the deployed text-based PRE_TEST/POST_TEST schema.';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.peka_questions'::regclass
       and c.contype = 'p'
       and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
  ) then
    raise exception 'Expected peka_questions primary key on id; inspect the live schema before applying this migration.';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.peka_questions'::regclass
       and c.contype = 'u'
       and pg_get_constraintdef(c.oid) = 'UNIQUE (question_order)'
  ) then
    raise exception 'Expected the existing UNIQUE(question_order) constraint; inspect the question schema before applying the 15-question bank.';
  end if;

  if (
    select count(*) = 30
       and (
         (
           count(*) filter (where is_active) = 30
           and count(*) filter (where id between 1 and 30 and question_order = id) = 30
         )
         or
         (
           count(*) filter (where is_active) = 0
           and count(*) filter (where id between 1 and 30 and question_order = id + 15) = 30
         )
       )
       and count(*) filter (
         where id between 1 and 30
           and timer_seconds = 60
           and answer_key_verified
           and answer_key between 0 and 3
           and jsonb_typeof(options) = 'array'
           and jsonb_array_length(options) = 4
       ) = 30
      from public.peka_questions
  ) is not true then
    raise exception 'Expected exactly 30 verified legacy questions in the supported stable or archived 16-45 order; no question rows were changed.';
  end if;

  if exists (
    select 1
      from public.peka_questions
     where id between 31 and 45
  ) then
    raise exception 'Question IDs 31-45 are already in use; inspect the question bank before applying this migration.';
  end if;

  if exists (
    select 1
      from public.peka_quiz_sessions s
     where not private.is_valid_peka_question_sequence(s.question_sequence)
        or cardinality(s.question_sequence) <> 30
  ) then
    raise exception 'A historical session has an unexpected question sequence; refusing to alter the sequence contract.';
  end if;

  if exists (
    select 1
      from public.peka_quiz_sessions s
     where s.status = 'completed'
       and (
         s.current_question_order <> 31
         or (select count(*) from public.peka_answers a where a.session_id = s.id) <> 30
       )
  ) then
    raise exception 'A completed historical session has an inconsistent answer count/order; inspect historical results before migration.';
  end if;

  if exists (
    select 1
      from public.peka_quiz_sessions s
     where s.status = 'in_progress'
       and (
         not private.is_valid_peka_question_sequence(s.question_sequence)
         or cardinality(s.question_sequence) <> 30
         or s.question_sequence[s.current_question_order] is null
         or exists (
           select 1
             from public.peka_answers a
            where a.session_id = s.id
              and not (a.question_id = any(s.question_sequence))
         )
         or exists (
           select 1
             from public.peka_answers a
            where a.session_id = s.id
              and a.question_id = s.question_sequence[s.current_question_order]
         )
       )
  ) then
    raise exception 'An in-progress legacy session has an unexpected sequence or answer state; no question rows were changed.';
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
    and array_upper(p_sequence, 1) = cardinality(p_sequence)
    and (
      (
        cardinality(p_sequence) = 30
        and (
          select count(question_id) = 30 and min(question_id) = 1 and max(question_id) = 30
            from (select distinct unnest(p_sequence) as question_id) ids
        )
      )
      or (
        cardinality(p_sequence) = 15
        and (
          select count(question_id) = 15 and min(question_id) = 31 and max(question_id) = 45
            from (select distinct unnest(p_sequence) as question_id) ids
        )
      )
    ),
    false
  );
$$;

revoke all on function private.is_valid_peka_question_sequence(smallint[])
  from public, anon, authenticated;
grant execute on function private.is_valid_peka_question_sequence(smallint[])
  to service_role;

alter table public.peka_quiz_sessions
  drop constraint if exists peka_session_question_sequence_valid;
alter table public.peka_quiz_sessions
  add constraint peka_session_question_sequence_valid
  check (private.is_valid_peka_question_sequence(question_sequence));

alter table public.peka_quiz_sessions
  alter column question_sequence set default array[
    31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45
  ]::smallint[];

alter table public.peka_quiz_sessions
  drop constraint if exists peka_session_completion_consistent;
alter table public.peka_quiz_sessions
  add constraint peka_session_completion_consistent check (
    (status = 'in_progress' and completed_at is null)
    or (
      status = 'completed'
      and completed_at is not null
      and current_question_order = cardinality(question_sequence) + 1
    )
  );

do $drop_question_order_unique$
declare
  v_constraint_name text;
begin
  for v_constraint_name in
    select c.conname
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.peka_questions'::regclass
       and c.contype = 'u'
       and pg_get_constraintdef(c.oid) = 'UNIQUE (question_order)'
  loop
    execute format(
      'alter table public.peka_questions drop constraint %I',
      v_constraint_name
    );
  end loop;
end;
$drop_question_order_unique$;

update public.peka_questions
   set is_active = false,
       updated_at = now()
 where id between 1 and 30
   and is_active;

create unique index peka_questions_active_order_uidx
  on public.peka_questions (question_order)
  where is_active;

insert into public.peka_questions (
  id, question_order, question_text, options, timer_seconds, is_active,
  answer_key, answer_key_verified, updated_at
)
values
  (31, 1, 'Apa kepanjangan dari PeKA?',
   jsonb_build_array('Peduli, Kenali, Adukan', 'Peduli, Ketahui, Amankan', 'Periksa, Kenali, Adukan', 'Peduli, Kontrol, Amankan'), 60, true, 0, true, now()),
  (32, 2, 'Dalam konsep PeKA, sikap “Peduli” berarti...',
   jsonb_build_array('Tidak memperhatikan risiko', 'Memiliki kepedulian terhadap keamanan dan perlindungan diri sebagai konsumen', 'Selalu mengikuti semua promosi', 'Membagikan informasi pribadi kepada orang lain'), 60, true, 1, true, now()),
  (33, 3, 'Dalam konsep PeKA, “Kenali” berarti...',
   jsonb_build_array('Mengenali produk, layanan, manfaat, dan risikonya sebelum menggunakan', 'Mengenali semua pegawai bank', 'Mengenali nomor telepon teman', 'Mengenali produk yang paling mahal'), 60, true, 0, true, now()),
  (34, 4, 'Dalam konsep PeKA, “Adukan” berarti...',
   jsonb_build_array('Menyebarkan keluhan di media sosial', 'Membiarkan masalah yang terjadi', 'Menyampaikan pengaduan melalui kanal yang tepat', 'Menghapus bukti transaksi'), 60, true, 2, true, now()),
  (35, 5, 'Jika konsumen mengalami permasalahan dengan layanan keuangan, langkah yang tepat adalah...',
   jsonb_build_array('Membiarkannya', 'Menyampaikan pengaduan kepada penyedia layanan', 'Menghapus bukti transaksi', 'Menyebarkan masalah ke media sosial'), 60, true, 1, true, now()),
  (36, 6, 'BI Bicara merupakan kanal yang dapat digunakan masyarakat untuk...',
   jsonb_build_array('Membeli produk keuangan', 'Menyampaikan informasi dan pengaduan kepada Bank Indonesia', 'Membuka rekening bank', 'Mengajukan pinjaman online'), 60, true, 1, true, now()),
  (37, 7, 'Salah satu cara mengakses layanan BI Bicara adalah melalui...',
   jsonb_build_array('bicara.bi.go.id', 'google.bi.go.id', 'bankindonesia.shop', 'qris.bi.store'), 60, true, 0, true, now()),
  (38, 8, 'Jika ingin menyampaikan pengaduan kepada Bank Indonesia, konsumen sebaiknya...',
   jsonb_build_array('Menyiapkan informasi dan bukti yang berkaitan dengan permasalahan', 'Menghapus seluruh bukti transaksi', 'Memberikan PIN kepada petugas', 'Membagikan password akun'), 60, true, 0, true, now()),
  (39, 9, 'Manakah data yang harus dijaga kerahasiaannya oleh konsumen?',
   jsonb_build_array('Kode OTP dan PIN', 'Nama bank', 'Logo bank', 'Alamat kantor bank'), 60, true, 0, true, now()),
  (40, 10, 'Jika menerima pesan yang meminta kode OTP, tindakan yang tepat adalah...',
   jsonb_build_array('Memberikan OTP jika pengirim mengaku sebagai petugas bank', 'Memberikan OTP kepada teman', 'Tidak memberikan OTP kepada siapa pun', 'Mengunggah OTP di media sosial'), 60, true, 2, true, now()),
  (41, 11, 'Sebelum menggunakan produk atau layanan keuangan, konsumen sebaiknya...',
   jsonb_build_array('Membaca dan memahami informasi produk terlebih dahulu', 'Langsung menggunakannya', 'Hanya melihat iklannya', 'Mengikuti teman tanpa mencari informasi'), 60, true, 0, true, now()),
  (42, 12, 'Jika mendapatkan link mencurigakan dari nomor tidak dikenal, sebaiknya...',
   jsonb_build_array('Langsung klik', 'Masukkan data pribadi untuk verifikasi', 'Jangan klik dan lakukan verifikasi melalui kanal resmi', 'Teruskan ke semua kontak'), 60, true, 2, true, now()),
  (43, 13, 'Mengapa bukti transaksi perlu disimpan?',
   jsonb_build_array('Untuk memenuhi memori ponsel', 'Dapat digunakan sebagai bukti ketika terjadi permasalahan', 'Untuk dibagikan ke media sosial', 'Agar transaksi menjadi lebih cepat'), 60, true, 1, true, now()),
  (44, 14, 'Manakah contoh perilaku konsumen yang cerdas?',
   jsonb_build_array('Mudah percaya pada hadiah atau promo yang tidak jelas', 'Memberikan data pribadi kepada orang yang tidak dikenal', 'Mengecek informasi melalui kanal resmi sebelum melakukan transaksi', 'Membagikan kode OTP kepada petugas'), 60, true, 2, true, now()),
  (45, 15, 'Jika ragu terhadap suatu informasi atau tawaran yang mencurigakan, sesuai semangat PeKA sebaiknya...',
   jsonb_build_array('Langsung percaya', 'Langsung klik', 'Kalau Ragu, Stop Dulu dan lakukan verifikasi', 'Sebarkan kepada teman'), 60, true, 2, true, now());

do $verify_bank$
declare
  v_active_count integer;
begin
  select count(*)
    into v_active_count
    from public.peka_questions
   where is_active
     and id between 31 and 45
     and question_order between 1 and 15
     and answer_key_verified
     and answer_key between 0 and 3
     and timer_seconds = 60;

  if v_active_count <> 15
     or (select count(*) from public.peka_questions where is_active) <> 15
     or exists (
       select 1
         from public.peka_questions
        where is_active
          and question_order <> id - 30
     ) then
    raise exception 'The active PeKA bank must contain exactly 15 verified questions with IDs 31-45 and order 1-15; transaction rolled back.';
  end if;
end;
$verify_bank$;

do $migration$
declare
  v_argument_names text[];
  v_arguments text;
begin
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
    raise exception 'Expected public.advance_peka_quiz(uuid,uuid,text,smallint,smallint).';
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
  v_correct boolean;
  v_answer_key_verified boolean;
  v_answer_count bigint;
  v_question_count integer;
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

  if not private.is_valid_peka_question_sequence(v_session.question_sequence) then
    raise exception 'invalid_question_sequence' using errcode = '23514';
  end if;
  v_question_count := cardinality(v_session.question_sequence);

  v_now := clock_timestamp();
  if v_session.status = 'completed' then
    select count(*)
      into v_answer_count
      from public.peka_answers a
     where a.session_id = v_session.id;
    if v_session.current_question_order <> v_question_count + 1
       or v_answer_count <> v_question_count then
      raise exception 'completed_session_incomplete' using errcode = '23514';
    end if;
    return jsonb_build_object(
      'completed', true,
      'question_count', v_question_count
    );
  end if;

  if v_session.current_question_order > v_question_count then
    raise exception 'invalid_question_order' using errcode = '23514';
  end if;

  v_expired := v_now >= v_session.question_started_at + interval '60 seconds';
  if $3 = 'current' and not v_expired then
    select q.*
      into v_question
      from public.peka_questions q
     where q.id = v_session.question_sequence[v_session.current_question_order];
    if not found then
      raise exception 'session_question_not_found' using errcode = 'P0002';
    end if;

    return jsonb_build_object(
      'completed', false,
      'question_count', v_question_count,
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
   where q.id = v_session.question_sequence[v_session.current_question_order];
  if not found then
    raise exception 'session_question_not_found' using errcode = 'P0002';
  end if;

  v_selected := case
    when $3 = 'answer' and not v_expired then $5
    else null
  end;
  v_answer_key_verified := v_question.answer_key_verified;
  v_correct := case
    when v_selected is not null and v_answer_key_verified
      then v_selected = v_question.answer_key
    else null
  end;

  insert into public.peka_answers (
    session_id, question_id, selected_option, is_correct, timed_out, answered_at
  ) values (
    v_session.id, v_question.id, v_selected, v_correct, v_selected is null, v_now
  );

  if v_session.current_question_order = v_question_count then
    update public.peka_quiz_sessions
       set current_question_order = v_question_count + 1,
           status = 'completed',
           completed_at = v_now
     where id = v_session.id;
    return jsonb_build_object(
      'completed', true,
      'question_count', v_question_count,
      'answer_timed_out', v_selected is null,
      'feedback', case
        when v_selected is not null and v_answer_key_verified
          then jsonb_build_object('is_correct', v_correct)
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
   where q.id = v_session.question_sequence[v_session.current_question_order];
  if not found then
    raise exception 'session_question_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'completed', false,
    'question_count', v_question_count,
    'answer_timed_out', v_selected is null,
    'feedback', case
      when v_selected is not null and v_answer_key_verified
        then jsonb_build_object('is_correct', v_correct)
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

revoke all on function public.advance_peka_quiz(uuid, uuid, text, smallint, smallint)
  from public, anon, authenticated;
grant execute on function public.advance_peka_quiz(uuid, uuid, text, smallint, smallint)
  to service_role;

create or replace function public.advance_peka_quiz_v2(
  p_session_id uuid,
  p_participant_id uuid,
  p_action text,
  p_question_order smallint default null,
  p_selected_option smallint default null
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select public.advance_peka_quiz(
    p_session_id,
    p_participant_id,
    p_action,
    p_question_order,
    p_selected_option
  );
$$;

revoke all on function public.advance_peka_quiz_v2(uuid, uuid, text, smallint, smallint)
  from public, anon, authenticated;
grant execute on function public.advance_peka_quiz_v2(uuid, uuid, text, smallint, smallint)
  to service_role;

create or replace function public.claim_peka_completion_email(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_email public.peka_completion_emails%rowtype;
  v_session public.peka_quiz_sessions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_name text;
  v_recipient text;
  v_answer_count bigint;
  v_question_count integer;
begin
  select e.*
    into v_email
    from public.peka_completion_emails e
   where e.session_id = p_session_id
   for update of e;

  if not found then
    return jsonb_build_object('status', 'not_queued', 'retryable', false);
  end if;

  select s.*
    into v_session
    from public.peka_quiz_sessions s
   where s.id = p_session_id;

  if not found then
    return jsonb_build_object('status', 'not_ready', 'retryable', false);
  end if;

  select p.full_name, p.email
    into v_name, v_recipient
    from public.peka_participants p
   where p.id = v_session.participant_id;

  if not found then
    return jsonb_build_object('status', 'not_ready', 'retryable', false);
  end if;

  if not private.is_valid_peka_question_sequence(v_session.question_sequence) then
    return jsonb_build_object('status', 'not_ready', 'retryable', false);
  end if;
  v_question_count := cardinality(v_session.question_sequence);

  select count(*)
    into v_answer_count
    from public.peka_answers a
   where a.session_id = p_session_id;
  if v_session.status <> 'completed'
     or v_session.current_question_order <> v_question_count + 1
     or v_answer_count <> v_question_count
     or v_session.quiz_type not in ('PRE_TEST', 'POST_TEST')
     or v_recipient !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    return jsonb_build_object('status', 'not_ready', 'retryable', false);
  end if;

  if v_email.status = 'accepted' then
    return jsonb_build_object('status', 'accepted', 'retryable', false);
  end if;
  if v_email.status = 'sending' and v_email.locked_until > v_now then
    return jsonb_build_object('status', 'sending', 'retryable', true);
  end if;
  if v_email.attempt_count >= 5 then
    return jsonb_build_object('status', 'failed', 'retryable', false);
  end if;
  if v_email.next_attempt_at > v_now then
    return jsonb_build_object(
      'status', 'retry_wait',
      'retryable', true,
      'retry_after', ceil(extract(epoch from (v_email.next_attempt_at - v_now)))::integer
    );
  end if;

  update public.peka_completion_emails
     set status = 'sending',
         attempt_count = attempt_count + 1,
         locked_until = v_now + interval '5 minutes',
         updated_at = v_now,
         last_error = null
   where id = v_email.id
   returning * into v_email;

  return jsonb_build_object(
    'status', 'sending',
    'retryable', true,
    'outbox_id', v_email.id,
    'attempt', v_email.attempt_count,
    'recipient', v_recipient,
    'full_name', v_name,
    'quiz_type', v_session.quiz_type
  );
end;
$$;

revoke all on function public.claim_peka_completion_email(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_peka_completion_email(uuid)
  to service_role;

commit;
