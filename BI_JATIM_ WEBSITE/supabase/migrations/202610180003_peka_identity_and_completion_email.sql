begin;

alter table public.peka_participants
  alter column auth_user_id drop not null;

create table if not exists public.peka_completion_emails (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique
    references public.peka_quiz_sessions(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'accepted', 'failed')),
  attempt_count smallint not null default 0
    check (attempt_count between 0 and 5),
  provider_message_id text,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint peka_completion_email_state_consistent check (
    (status = 'sending' and locked_until is not null)
    or (status <> 'sending' and locked_until is null)
  )
);

create index if not exists peka_completion_emails_retry_idx
  on public.peka_completion_emails (status, next_attempt_at);

alter table public.peka_completion_emails enable row level security;
revoke all on public.peka_completion_emails from public, anon, authenticated;
grant all on public.peka_completion_emails to service_role;

create or replace function private.queue_peka_completion_email()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if old.status <> 'completed' and new.status = 'completed' then
    insert into public.peka_completion_emails (session_id)
    values (new.id)
    on conflict (session_id) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function private.queue_peka_completion_email()
  from public, anon, authenticated;
grant execute on function private.queue_peka_completion_email()
  to service_role;

drop trigger if exists peka_queue_completion_email
  on public.peka_quiz_sessions;
create trigger peka_queue_completion_email
  after update of status on public.peka_quiz_sessions
  for each row
  when (old.status is distinct from new.status)
  execute function private.queue_peka_completion_email();

-- Replace the RPC in place so dependencies and its installed argument names survive.
do $migration$
declare
  v_argument_names text[];
  v_arguments text;
begin
  select p.proargnames
    into v_argument_names
    from pg_catalog.pg_proc p
   where p.oid = to_regprocedure(
     'public.advance_peka_quiz(uuid,uuid,text,smallint,smallint)'
   );

  if not found then
    raise exception 'Expected public.advance_peka_quiz(uuid,uuid,text,smallint,smallint) from migration 002.';
  end if;

  v_arguments := format(
    '%I uuid, %I uuid, %I text, %I smallint default null, %I smallint default null',
    coalesce(v_argument_names[1], 'p_session_id'),
    coalesce(v_argument_names[2], 'p_participant_id'),
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
  v_answer_key_verified boolean;
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

  if v_session.current_question_order = 30 then
    update public.peka_quiz_sessions
       set current_question_order = 31,
           status = 'completed',
           completed_at = v_now
     where id = v_session.id;
    return jsonb_build_object(
      'completed', true,
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
   where q.question_order = v_session.current_question_order
     and q.is_active;
  if not found then
    raise exception 'active_question_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'completed', false,
    'feedback', case
      when v_selected is not null and v_answer_key_verified
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

revoke all on function public.advance_peka_quiz(uuid, uuid, text, smallint, smallint)
  from public, anon, authenticated;
grant execute on function public.advance_peka_quiz(uuid, uuid, text, smallint, smallint)
  to service_role;

create or replace function public.claim_peka_completion_email(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_email public.peka_completion_emails%rowtype;
  v_now timestamptz := clock_timestamp();
  v_name text;
  v_recipient text;
  v_quiz_type text;
  v_session_status text;
  v_question_order smallint;
  v_answer_count bigint;
begin
  select e.*
    into v_email
    from public.peka_completion_emails e
   where e.session_id = p_session_id
   for update of e;

  if not found then
    return jsonb_build_object('status', 'not_queued', 'retryable', false);
  end if;

  select p.full_name, p.email, s.quiz_type, s.status, s.current_question_order
    into v_name, v_recipient, v_quiz_type, v_session_status, v_question_order
    from public.peka_quiz_sessions s
    join public.peka_participants p on p.id = s.participant_id
   where s.id = p_session_id;

  if not found then
    return jsonb_build_object('status', 'not_ready', 'retryable', false);
  end if;

  select count(*)
    into v_answer_count
    from public.peka_answers a
   where a.session_id = p_session_id;
  if v_session_status <> 'completed' or v_question_order <> 31 or v_answer_count <> 30
     or v_quiz_type not in ('PRE_TEST', 'POST_TEST')
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
    'quiz_type', v_quiz_type
  );
end;
$$;

revoke all on function public.claim_peka_completion_email(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_peka_completion_email(uuid)
  to service_role;

create or replace function public.finish_peka_completion_email(
  p_outbox_id uuid,
  p_attempt smallint,
  p_accepted boolean,
  p_provider_message_id text default null,
  p_error text default null,
  p_retry_after_seconds integer default 60
)
returns boolean
language sql
security definer
set search_path = pg_catalog
as $$
  update public.peka_completion_emails
     set status = case when p_accepted then 'accepted' else 'failed' end,
         provider_message_id = case when p_accepted then p_provider_message_id else null end,
         accepted_at = case when p_accepted then clock_timestamp() else null end,
         last_error = case when p_accepted then null else left(coalesce(p_error, 'email_provider_error'), 500) end,
         next_attempt_at = case
           when p_accepted then next_attempt_at
           else clock_timestamp() + make_interval(secs => greatest(1, least(p_retry_after_seconds, 3600)))
         end,
         locked_until = null,
         updated_at = clock_timestamp()
   where id = p_outbox_id
     and status = 'sending'
     and attempt_count = p_attempt
  returning true;
$$;

revoke all on function public.finish_peka_completion_email(uuid, smallint, boolean, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.finish_peka_completion_email(uuid, smallint, boolean, text, text, integer)
  to service_role;

commit;
