do $preflight$
begin
  if to_regclass('public.peka_participants') is not null
     and not exists (
       select 1
         from information_schema.columns c
        where c.table_schema = 'public'
          and c.table_name = 'peka_participants'
          and c.column_name = 'auth_user_id'
          and c.data_type = 'uuid'
          and c.is_nullable = 'NO'
     ) then
    raise exception 'Migration 001 expects the auth_user_id identity schema; inspect existing PeKA objects before applying it.';
  end if;
end;
$preflight$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists public.peka_participants (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 2 and 120),
  email text not null check (char_length(email) between 3 and 254),
  institution text not null check (char_length(institution) between 2 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists peka_participants_email_lower_uidx
  on public.peka_participants (lower(email));

create table if not exists public.peka_questions (
  id smallint primary key,
  question_order smallint not null unique check (question_order between 1 and 30),
  question_text text not null,
  options jsonb not null check (
    jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 4
  ),
  category text,
  timer_seconds smallint not null default 60 check (timer_seconds = 60),
  is_active boolean not null default true,
  answer_key smallint check (answer_key between 0 and 3),
  answer_key_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint peka_question_key_requires_verification
    check (not answer_key_verified or answer_key is not null)
);

create table if not exists public.peka_quiz_sessions (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.peka_participants(id) on delete restrict,
  quiz_type text not null check (quiz_type in ('PRE_TEST', 'POST_TEST')),
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed')),
  current_question_order smallint not null default 1
    check (current_question_order between 1 and 31),
  started_at timestamptz not null default now(),
  question_started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint peka_one_attempt_per_test unique (participant_id, quiz_type),
  constraint peka_session_completion_consistent check (
    (status = 'in_progress' and completed_at is null)
    or (status = 'completed' and completed_at is not null and current_question_order = 31)
  )
);

create index if not exists peka_quiz_sessions_type_status_idx
  on public.peka_quiz_sessions (quiz_type, status);

create table if not exists public.peka_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.peka_quiz_sessions(id) on delete restrict,
  question_id smallint not null references public.peka_questions(id) on delete restrict,
  selected_option smallint check (selected_option between 0 and 3),
  is_correct boolean,
  timed_out boolean not null default false,
  answered_at timestamptz not null default now(),
  constraint peka_one_final_answer_per_question unique (session_id, question_id),
  constraint peka_timeout_has_no_selection check (
    not timed_out or selected_option is null
  )
);

create index if not exists peka_answers_session_idx
  on public.peka_answers (session_id);

create or replace function private.prevent_invalid_peka_session_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.status = 'completed' and new.status <> 'completed' then
    raise exception 'completed quiz sessions cannot be reopened';
  end if;

  if old.status <> new.status
     and not (old.status = 'in_progress' and new.status = 'completed') then
    raise exception 'invalid quiz session status transition';
  end if;

  return new;
end;
$$;

drop trigger if exists peka_session_status_transition
  on public.peka_quiz_sessions;
create trigger peka_session_status_transition
  before update of status on public.peka_quiz_sessions
  for each row execute function private.prevent_invalid_peka_session_transition();

-- CREATE OR REPLACE cannot rename installed input parameters; preserve their names.
do $migration$
declare
  v_argument_names text[];
  v_arguments text;
  v_function_exists boolean;
begin
  select p.proargnames
    into v_argument_names
    from pg_catalog.pg_proc p
   where p.oid = to_regprocedure(
     'public.advance_peka_quiz(uuid,uuid,text,smallint,smallint)'
   );
  v_function_exists := found;

  if v_function_exists and exists (
    select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'advance_peka_quiz'
       and p.oid <> to_regprocedure(
         'public.advance_peka_quiz(uuid,uuid,text,smallint,smallint)'
       )
  ) then
    raise exception 'Unexpected overload of public.advance_peka_quiz exists; inspect it before applying migration 001.';
  end if;

  if not v_function_exists and exists (
    select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'advance_peka_quiz'
  ) then
    raise exception 'A different overload of public.advance_peka_quiz exists; inspect it before applying migration 001.';
  end if;

  if not v_function_exists then
    v_argument_names := array[
      'p_session_id', 'p_auth_user_id', 'p_action',
      'p_question_order', 'p_selected_option'
    ]::text[];
  end if;

  v_arguments := format(
    '%I uuid, %I uuid, %I text, %I smallint default null, %I smallint default null',
    coalesce(v_argument_names[1], 'p_session_id'),
    coalesce(v_argument_names[2], 'p_auth_user_id'),
    coalesce(v_argument_names[3], 'p_action'),
    coalesce(v_argument_names[4], 'p_question_order'),
    coalesce(v_argument_names[5], 'p_selected_option')
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
    join public.peka_participants p on p.id = s.participant_id
   where s.id = $1
     and p.auth_user_id = $2
   for update of s;

  if not found then
    raise exception 'session_not_found' using errcode = '42501';
  end if;

  v_now := clock_timestamp();

  if v_session.status = 'completed' then
    return jsonb_build_object('completed', true);
  end if;

  v_expired := v_now >= v_session.question_started_at + interval '60 seconds';

  if $3 = 'current' and not v_expired then
    select q.*
      into v_question
      from public.peka_questions q
     where q.question_order = v_session.current_question_order
       and q.is_active;

    if not found then
      raise exception 'active_question_not_found' using errcode = 'P0002';
    end if;

    return jsonb_build_object(
      'completed', false,
      'question', jsonb_build_object(
        'order', v_question.question_order,
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
   where q.question_order = v_session.current_question_order
     and q.is_active;

  if not found then
    raise exception 'active_question_not_found' using errcode = 'P0002';
  end if;

  v_selected := case
    when $3 = 'answer' and not v_expired then $5
    else null
  end;

  if v_selected is not null and v_question.answer_key_verified then
    v_correct := v_selected = v_question.answer_key;
  else
    v_correct := null;
  end if;

  insert into public.peka_answers (
    session_id,
    question_id,
    selected_option,
    is_correct,
    timed_out,
    answered_at
  ) values (
    v_session.id,
    v_question.id,
    v_selected,
    v_correct,
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
      'feedback', case
        when v_selected is not null and v_question.answer_key_verified
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
   where q.question_order = v_session.current_question_order
     and q.is_active;

  if not found then
    raise exception 'active_question_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'completed', false,
    'feedback', case
      when v_selected is not null and v_question.answer_key_verified
        then jsonb_build_object('is_correct', v_correct)
      else null
    end,
    'question', jsonb_build_object(
      'order', v_question.question_order,
      'question', v_question.question_text,
      'options', v_question.options
    ),
    'seconds_remaining', 60
  );
end;
$body$;
$ddl$, v_arguments);
end;
$migration$;

alter table public.peka_participants enable row level security;
alter table public.peka_questions enable row level security;
alter table public.peka_quiz_sessions enable row level security;
alter table public.peka_answers enable row level security;

revoke all on public.peka_participants from public, anon, authenticated;
revoke all on public.peka_questions from public, anon, authenticated;
revoke all on public.peka_quiz_sessions from public, anon, authenticated;
revoke all on public.peka_answers from public, anon, authenticated;
grant all on public.peka_participants to service_role;
grant all on public.peka_questions to service_role;
grant all on public.peka_quiz_sessions to service_role;
grant all on public.peka_answers to service_role;

revoke all on function public.advance_peka_quiz(uuid, uuid, text, smallint, smallint)
  from public, anon, authenticated;
grant execute on function public.advance_peka_quiz(uuid, uuid, text, smallint, smallint)
  to service_role;
