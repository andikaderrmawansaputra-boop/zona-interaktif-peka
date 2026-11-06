begin;

do $preflight$
begin
  if to_regclass('public.peka_questions') is null
     or to_regclass('public.peka_quiz_sessions') is null
     or to_regclass('public.peka_answers') is null then
    raise exception 'Required PeKA quiz tables are missing; migration aborted without changing data.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'peka_quiz_sessions'
       and column_name = 'question_sequence' and data_type = 'ARRAY'
  ) then
    raise exception 'Apply the existing shuffled-question migration first; historical sessions must retain their question sequences.';
  end if;
  if exists (select 1 from public.peka_questions where id > 30) then
    raise exception 'Unexpected question IDs above 30 already exist; inspect before assigning new stable IDs.';
  end if;
  if exists (
    select 1 from public.peka_quiz_sessions s
     where s.status = 'in_progress'
       and (cardinality(s.question_sequence) not in (15, 30)
         or s.question_sequence[s.current_question_order] is null)
  ) then
    raise exception 'An in-progress session has an invalid sequence; migration stopped to preserve it.';
  end if;
end;
$preflight$;

-- Keep all old question IDs, text, options, and keys intact for old answers.
-- Move their catalog order out of the new active range; no session/answer rows are rewritten.
alter table public.peka_questions drop constraint if exists peka_questions_question_order_check;
alter table public.peka_questions drop constraint if exists peka_questions_question_order_key;
update public.peka_questions set question_order = (id + 100)::smallint where id between 1 and 30;
update public.peka_questions set question_order = (id + 15)::smallint, is_active = false where id between 1 and 30;
alter table public.peka_questions
  add constraint peka_questions_question_order_check check (question_order between 1 and 45);
alter table public.peka_questions
  add constraint peka_questions_question_order_key unique (question_order);

create or replace function private.is_valid_peka_question_sequence(p_sequence smallint[])
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(
    array_ndims(p_sequence) = 1
    and array_lower(p_sequence, 1) = 1
    and cardinality(p_sequence) in (15, 30)
    and array_upper(p_sequence, 1) = cardinality(p_sequence)
    and (select count(distinct question_id) = cardinality(p_sequence)
           from unnest(p_sequence) as ids(question_id)),
    false
  );
$$;
revoke all on function private.is_valid_peka_question_sequence(smallint[]) from public, anon, authenticated;
grant execute on function private.is_valid_peka_question_sequence(smallint[]) to service_role;

alter table public.peka_quiz_sessions drop constraint if exists peka_session_question_sequence_valid;
alter table public.peka_quiz_sessions add constraint peka_session_question_sequence_valid
  check (private.is_valid_peka_question_sequence(question_sequence));
alter table public.peka_quiz_sessions drop constraint if exists peka_session_completion_consistent;
alter table public.peka_quiz_sessions add constraint peka_session_completion_consistent check (
  (status = 'in_progress' and completed_at is null)
  or (status = 'completed' and completed_at is not null and current_question_order in (16, 31))
);

-- Preserve the installed RPC argument names and use each session's immutable sequence length.
do $migration$
declare
  v_names text[];
  v_args text;
begin
  select p.proargnames into v_names from pg_catalog.pg_proc p
   where p.oid = to_regprocedure('public.advance_peka_quiz(uuid,uuid,text,smallint,smallint)');
  if not found then raise exception 'Expected the existing advance_peka_quiz RPC; migration aborted.'; end if;
  v_args := format('%I uuid, %I uuid, %I text, %I smallint default null, %I smallint default null',
    coalesce(v_names[1], 'p_session_id'), coalesce(v_names[2], 'p_participant_id'),
    coalesce(v_names[3], 'p_action'), coalesce(v_names[4], 'p_question_order'),
    coalesce(v_names[5], 'p_selected_option'));
  execute format($ddl$
    create or replace function public.advance_peka_quiz(%s)
    returns jsonb language plpgsql security definer set search_path = pg_catalog
    as $body$
    declare
      v_session public.peka_quiz_sessions%%rowtype;
      v_question public.peka_questions%%rowtype;
      v_now timestamptz := clock_timestamp();
      v_expired boolean;
      v_selected smallint;
      v_answer_count bigint;
      v_question_total integer;
      v_correct boolean;
    begin
      if $3 not in ('current', 'answer') then raise exception 'invalid_action' using errcode = '22023'; end if;
      if $3 = 'answer' and ($4 is null or ($5 is not null and $5 not between 0 and 3)) then
        raise exception 'invalid_answer' using errcode = '22023';
      end if;
      select s.* into v_session from public.peka_quiz_sessions s
       where s.id = $1 and s.participant_id = $2 for update;
      if not found then raise exception 'session_not_found' using errcode = '42501'; end if;
      v_question_total := cardinality(v_session.question_sequence);
      if not private.is_valid_peka_question_sequence(v_session.question_sequence) then
        raise exception 'invalid_question_sequence' using errcode = '23514';
      end if;
      if v_session.status = 'completed' then
        select count(*) into v_answer_count from public.peka_answers a where a.session_id = v_session.id;
        if v_session.current_question_order <> v_question_total + 1 or v_answer_count <> v_question_total then
          raise exception 'completed_session_incomplete' using errcode = '23514';
        end if;
        return jsonb_build_object('completed', true);
      end if;
      if v_session.current_question_order > v_question_total then
        raise exception 'invalid_current_question_order' using errcode = '23514';
      end if;
      v_expired := v_now >= v_session.question_started_at + interval '60 seconds';
      if $3 = 'answer' and $4 <> v_session.current_question_order then
        raise exception 'stale_question' using errcode = '40001';
      end if;
      if $3 = 'answer' and not v_expired and $5 is null then
        raise exception 'timer_not_expired' using errcode = '22023';
      end if;
      if $3 = 'current' and not v_expired then
        select q.* into v_question from public.peka_questions q
         where q.id = v_session.question_sequence[v_session.current_question_order];
        if not found then raise exception 'active_question_not_found' using errcode = 'P0002'; end if;
        return jsonb_build_object('completed', false,
          'question', jsonb_build_object('id', v_question.id, 'order', v_session.current_question_order,
            'question', v_question.question_text, 'options', v_question.options),
          'seconds_remaining', greatest(1, ceil(extract(epoch from
            (v_session.question_started_at + interval '60 seconds' - v_now)))::integer));
      end if;
      select q.* into v_question from public.peka_questions q
       where q.id = v_session.question_sequence[v_session.current_question_order];
      if not found then raise exception 'active_question_not_found' using errcode = 'P0002'; end if;
      v_selected := case when $3 = 'answer' and not v_expired then $5 else null end;
      v_correct := case when v_selected is not null and v_question.answer_key_verified
        then v_selected = v_question.answer_key else null end;
      insert into public.peka_answers(session_id, question_id, selected_option, is_correct, timed_out, answered_at)
      values (v_session.id, v_question.id, v_selected, v_correct, v_selected is null, v_now);
      if v_session.current_question_order = v_question_total then
        update public.peka_quiz_sessions set current_question_order = v_question_total + 1,
          status = 'completed', completed_at = v_now where id = v_session.id;
        return jsonb_build_object('completed', true, 'answer_timed_out', v_selected is null,
          'feedback', case when v_selected is not null and v_question.answer_key_verified
            then jsonb_build_object('is_correct', v_correct) else null end);
      end if;
      update public.peka_quiz_sessions set current_question_order = current_question_order + 1,
        question_started_at = v_now where id = v_session.id returning * into v_session;
      select q.* into v_question from public.peka_questions q
       where q.id = v_session.question_sequence[v_session.current_question_order];
      if not found then raise exception 'active_question_not_found' using errcode = 'P0002'; end if;
      return jsonb_build_object('completed', false, 'answer_timed_out', v_selected is null,
        'feedback', case when v_selected is not null and v_question.answer_key_verified
          then jsonb_build_object('is_correct', v_correct) else null end,
        'question', jsonb_build_object('id', v_question.id, 'order', v_session.current_question_order,
          'question', v_question.question_text, 'options', v_question.options), 'seconds_remaining', 60);
    end;
    $body$;
  $ddl$, v_args);
end;
$migration$;

revoke all on function public.advance_peka_quiz(uuid, uuid, text, smallint, smallint) from public, anon, authenticated;
grant execute on function public.advance_peka_quiz(uuid, uuid, text, smallint, smallint) to service_role;

-- Completion email eligibility is based on the stored session sequence, so legacy 30-item
-- and new 15-item sessions both remain valid without changing the outbox or historical rows.
create or replace function public.claim_peka_completion_email(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_email public.peka_completion_emails%rowtype;
  v_now timestamptz := clock_timestamp();
  v_name text; v_recipient text; v_quiz_type text; v_status text;
  v_question_order smallint; v_total integer; v_answer_count bigint;
begin
  select e.* into v_email from public.peka_completion_emails e where e.session_id = p_session_id for update;
  if not found then return jsonb_build_object('status', 'not_queued', 'retryable', false); end if;
  select p.full_name, p.email, s.quiz_type, s.status, s.current_question_order, cardinality(s.question_sequence)
    into v_name, v_recipient, v_quiz_type, v_status, v_question_order, v_total
    from public.peka_quiz_sessions s join public.peka_participants p on p.id = s.participant_id
   where s.id = p_session_id;
  if not found then return jsonb_build_object('status', 'not_ready', 'retryable', false); end if;
  select count(*) into v_answer_count from public.peka_answers a where a.session_id = p_session_id;
  if v_status <> 'completed' or v_question_order <> v_total + 1 or v_answer_count <> v_total
     or v_total not in (15, 30) or v_quiz_type not in ('PRE_TEST', 'POST_TEST')
     or v_recipient !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    return jsonb_build_object('status', 'not_ready', 'retryable', false);
  end if;
  if v_email.status = 'accepted' then return jsonb_build_object('status', 'accepted', 'retryable', false); end if;
  if v_email.status = 'sending' and v_email.locked_until > v_now then return jsonb_build_object('status', 'sending', 'retryable', true); end if;
  if v_email.attempt_count >= 5 then return jsonb_build_object('status', 'failed', 'retryable', false); end if;
  if v_email.next_attempt_at > v_now then
    return jsonb_build_object('status', 'retry_wait', 'retryable', true,
      'retry_after', ceil(extract(epoch from (v_email.next_attempt_at - v_now)))::integer);
  end if;
  update public.peka_completion_emails set status = 'sending', attempt_count = attempt_count + 1,
    locked_until = v_now + interval '5 minutes', updated_at = v_now, last_error = null
   where id = v_email.id returning * into v_email;
  return jsonb_build_object('status', 'sending', 'retryable', true, 'outbox_id', v_email.id,
    'attempt', v_email.attempt_count, 'recipient', v_recipient, 'full_name', v_name, 'quiz_type', v_quiz_type);
end;
$$;
revoke all on function public.claim_peka_completion_email(uuid) from public, anon, authenticated;
grant execute on function public.claim_peka_completion_email(uuid) to service_role;
commit;
