-- Read-only checks for the deployed quiz RPC and data impact before migration 004.
-- Run in the SQL Editor for the linked project before deciding whether to deploy.

select
  p.oid::regprocedure as function_signature,
  p.proargnames as input_argument_names,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_get_function_arguments(p.oid) as declared_arguments,
  p.prosecdef as security_definer,
  p.proacl as privileges,
  pg_get_functiondef(p.oid) as function_definition
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('advance_peka_quiz', 'advance_peka_quiz_v2')
order by p.proname, p.oid::regprocedure::text;

select
  status,
  quiz_type,
  count(*) as session_count,
  count(*) filter (where status = 'in_progress') as in_progress_count,
  count(*) filter (where status = 'completed') as completed_count
from public.peka_quiz_sessions
group by status, quiz_type
order by quiz_type, status;

select
  count(*) as answer_count,
  count(distinct session_id) as sessions_with_answers
from public.peka_answers;

select
  count(*) filter (where is_active) as active_question_count,
  min(timer_seconds) filter (where is_active) as minimum_active_timer_seconds,
  max(timer_seconds) filter (where is_active) as maximum_active_timer_seconds,
  count(*) filter (where is_active and answer_key_verified) as active_verified_key_count
from public.peka_questions;

select to_regclass('supabase_migrations.schema_migrations') as migration_history_table;
