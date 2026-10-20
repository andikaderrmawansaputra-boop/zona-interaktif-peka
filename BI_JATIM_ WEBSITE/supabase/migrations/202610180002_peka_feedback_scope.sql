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
       and c.is_nullable = 'NO'
  ) then
    raise exception 'Migration 002 expects the auth_user_id identity schema from migration 001; inspect migration history before applying out of order.';
  end if;

  select p.proargnames
    into v_argument_names
    from pg_catalog.pg_proc p
   where p.oid = to_regprocedure(
     'public.advance_peka_quiz(uuid,uuid,text,smallint,smallint)'
   );

  if not found then
    raise exception 'Expected public.advance_peka_quiz(uuid,uuid,text,smallint,smallint) from migration 001.';
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
  v_answer_key_verified boolean;
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
  v_answer_key_verified := v_question.answer_key_verified;
  v_correct := case
    when v_selected is not null and v_answer_key_verified
      then v_selected = v_question.answer_key
    else null
  end;

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
