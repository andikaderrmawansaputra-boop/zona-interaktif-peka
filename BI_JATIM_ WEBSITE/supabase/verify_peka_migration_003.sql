-- Read-only preflight checks for migration 003.
-- Run this file in Supabase SQL Editor before deciding whether migration 003
-- can be applied. It returns only schema metadata and aggregate duplicate counts.
-- EXPECTED_CHANGE means migration 003 is intended to perform that transition;
-- STOP identifies a data conflict or an existing object migration 003 will not repair.

with
outbox as (
  select to_regclass('public.peka_completion_emails')::oid as oid
),
expected_outbox_columns(column_name, data_type, is_not_null) as (
  values
    ('id', 'uuid', true),
    ('session_id', 'uuid', true),
    ('status', 'text', true),
    ('attempt_count', 'smallint', true),
    ('provider_message_id', 'text', false),
    ('last_error', 'text', false),
    ('next_attempt_at', 'timestamp with time zone', true),
    ('locked_until', 'timestamp with time zone', false),
    ('accepted_at', 'timestamp with time zone', false),
    ('created_at', 'timestamp with time zone', true),
    ('updated_at', 'timestamp with time zone', true)
),
outbox_column_check as (
  select
    o.oid,
    coalesce(
      string_agg(e.column_name, ', ' order by e.column_name)
        filter (
          where a.attname is null
             or format_type(a.atttypid, a.atttypmod) <> e.data_type
             or a.attnotnull <> e.is_not_null
        ),
      ''
    ) as incompatible_columns
  from outbox o
  cross join expected_outbox_columns e
  left join pg_attribute a
    on a.attrelid = o.oid
   and a.attname = e.column_name
   and a.attnum > 0
   and not a.attisdropped
  group by o.oid
),
outbox_constraints as (
  select
    o.oid,
    exists (
      select 1
      from pg_constraint c
      where c.conrelid = o.oid
        and c.contype = 'u'
        and regexp_replace(
              replace(pg_get_constraintdef(c.oid), '"', ''),
              '[[:space:]]',
              '',
              'g'
            ) = 'UNIQUE(session_id)'
    ) as has_unique_session_id,
    exists (
      select 1
      from pg_constraint c
      where c.conrelid = o.oid
        and c.conname = 'peka_completion_email_state_consistent'
        and c.contype = 'c'
    ) as has_state_consistency_check
  from outbox o
),
outbox_retry_index as (
  select
    o.oid,
    exists (
      select 1
      from pg_index i
      join pg_class t on t.oid = i.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      where i.indrelid = o.oid
        and n.nspname = 'public'
        and t.relname = 'peka_completion_emails'
        and not i.indisunique
        and i.indisvalid
        and i.indisready
        and i.indpred is null
        and i.indnkeyatts = 2
        and right(
              regexp_replace(
                replace(pg_get_indexdef(i.indexrelid), '"', ''),
                '[[:space:]]',
                '',
                'g'
              ),
              length('(status,next_attempt_at)')
            ) = '(status,next_attempt_at)'
    ) as found_index
  from outbox o
),
outbox_access as (
  select
    o.oid,
    c.relrowsecurity,
    coalesce(
      (
        select bool_or(has_table_privilege(r.role_name, c.oid, p.privilege))
        from (values ('anon'), ('authenticated')) as r(role_name)
        cross join (
          values
            ('SELECT'),
            ('INSERT'),
            ('UPDATE'),
            ('DELETE'),
            ('TRUNCATE'),
            ('REFERENCES'),
            ('TRIGGER')
        ) as p(privilege)
      ),
      false
    ) as exposed_to_client_roles
  from outbox o
  left join pg_class c on c.oid = o.oid
),
email_duplicates as (
  select count(*)::bigint as duplicate_groups,
         coalesce(sum(participant_count - 1), 0)::bigint as extra_rows
  from (
    select lower(email) as normalized_email, count(*) as participant_count
    from public.peka_participants
    group by lower(email)
    having count(*) > 1
  ) d
),
session_duplicates as (
  select count(*)::bigint as duplicate_groups,
         coalesce(sum(session_count - 1), 0)::bigint as extra_rows
  from (
    select participant_id, quiz_type, count(*) as session_count
    from public.peka_quiz_sessions
    group by participant_id, quiz_type
    having count(*) > 1
  ) d
),
expected_functions(schema_name, function_name, argument_types, argument_names, return_type) as (
  values
    (
      'public',
      'advance_peka_quiz',
      'uuid,uuid,text,smallint,smallint',
      array['p_session_id', 'p_participant_id', 'p_action', 'p_question_order', 'p_selected_option']::text[],
      'jsonb'
    ),
    (
      'public',
      'claim_peka_completion_email',
      'uuid',
      array['p_session_id']::text[],
      'jsonb'
    ),
    (
      'public',
      'finish_peka_completion_email',
      'uuid,smallint,boolean,text,text,integer',
      array[
        'p_outbox_id',
        'p_attempt',
        'p_accepted',
        'p_provider_message_id',
        'p_error',
        'p_retry_after_seconds'
      ]::text[],
      'boolean'
    )
),
function_check as (
  select
    e.*,
    exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = e.schema_name
        and p.proname = e.function_name
        and replace(pg_catalog.oidvectortypes(p.proargtypes), ' ', '') = e.argument_types
        and (
          p.proargnames = e.argument_names
          or (
            e.function_name = 'advance_peka_quiz'
            and p.proargnames = array[
              'p_session_id', 'p_auth_user_id', 'p_action',
              'p_question_order', 'p_selected_option'
            ]::text[]
          )
        )
        and format_type(p.prorettype, null) = e.return_type
    ) as signature_matches,
    exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = e.schema_name
        and p.proname = e.function_name
        and replace(pg_catalog.oidvectortypes(p.proargtypes), ' ', '') = e.argument_types
        and (
          p.proargnames = e.argument_names
          or (
            e.function_name = 'advance_peka_quiz'
            and p.proargnames = array[
              'p_session_id', 'p_auth_user_id', 'p_action',
              'p_question_order', 'p_selected_option'
            ]::text[]
          )
        )
        and p.prosecdef
        and p.proconfig @> array['search_path=pg_catalog']
    ) as secure_definer_configuration
  from expected_functions e
),
advance_function_dependencies as (
  select
    count(distinct p.oid)::bigint as matching_functions,
    count(d.objid)::bigint as dependent_objects
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  left join pg_depend d
    on d.refclassid = 'pg_proc'::regclass
   and d.refobjid = p.oid
  where n.nspname = 'public'
    and p.proname = 'advance_peka_quiz'
    and replace(pg_catalog.oidvectortypes(p.proargtypes), ' ', '') =
      'uuid,uuid,text,smallint,smallint'
),
participant_email_index as (
  select exists (
    select 1
    from pg_index i
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'peka_participants'
      and i.indisunique
      and i.indisvalid
      and i.indisready
      and i.indpred is null
      and i.indnkeyatts = 1
      and regexp_replace(
            replace(pg_get_expr(i.indexprs, i.indrelid), '"', ''),
            '[[:space:]]',
            '',
            'g'
          ) = 'lower(email)'
  ) as found_index
),
participant_email_nullability as (
  select coalesce(
    (
      select c.is_nullable
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'peka_participants'
        and c.column_name = 'auth_user_id'
    ),
    'MISSING'
  ) as is_nullable
),
participant_attempt_constraint as (
  select exists (
    select 1
    from pg_constraint c
    where c.conrelid = to_regclass('public.peka_quiz_sessions')
      and c.contype = 'u'
      and regexp_replace(
            replace(pg_get_constraintdef(c.oid), '"', ''),
            '[[:space:]]',
            '',
            'g'
          ) = 'UNIQUE(participant_id,quiz_type)'
  ) as found_constraint
)
select check_name, status, details
from (
  select
    'completion_outbox_table'::text as check_name,
    case when o.oid is null then 'INFO' else 'PRESENT' end::text as status,
    case
      when o.oid is null then 'Table is absent; migration 003 may create it.'
      else 'Table exists; verify its reported columns and constraints before applying migration 003.'
    end::text as details
  from outbox o

  union all

  select
    'completion_outbox_columns',
    case
      when c.oid is null then 'NOT APPLICABLE'
      when c.incompatible_columns = '' then 'PASS'
      else 'STOP'
    end,
    case
      when c.oid is null then 'Table is absent; no table reference was evaluated.'
      when c.incompatible_columns = '' then 'All required migration 003 columns have the expected types and nullability.'
      else 'Missing or incompatible columns: ' || c.incompatible_columns
    end
  from outbox_column_check c

  union all

  select
    'completion_outbox_unique_session',
    case
      when c.oid is null then 'NOT APPLICABLE'
      when c.has_unique_session_id then 'PASS'
      else 'STOP'
    end,
    case
      when c.oid is null then 'Table is absent.'
      when c.has_unique_session_id then 'Unique constraint on session_id exists.'
      else 'Expected unique constraint on session_id is missing.'
    end
  from outbox_constraints c

  union all

  select
    'completion_outbox_retry_index',
    case
      when i.oid is null then 'NOT APPLICABLE'
      when i.found_index then 'PASS'
      else 'STOP'
    end,
    case
      when i.oid is null then 'Table is absent.'
      when i.found_index then 'Valid, non-partial retry index on (status, next_attempt_at) exists.'
      else 'Expected retry index on (status, next_attempt_at) is missing or incompatible.'
    end
  from outbox_retry_index i

  union all

  select
    'completion_outbox_state_check',
    case
      when c.oid is null then 'NOT APPLICABLE'
      when c.has_state_consistency_check then 'PASS'
      else 'STOP'
    end,
    case
      when c.oid is null then 'Table is absent.'
      when c.has_state_consistency_check then 'Named status/lock consistency check exists; inspect its definition if the table predates migration 003.'
      else 'Expected peka_completion_email_state_consistent check is missing.'
    end
  from outbox_constraints c

  union all

  select
    'participants_auth_user_id_nullable',
    case
      when n.is_nullable = 'YES' then 'PASS'
      when n.is_nullable = 'NO' then 'EXPECTED_CHANGE'
      else 'STOP'
    end,
    case
      when n.is_nullable = 'YES' then 'auth_user_id is nullable.'
      when n.is_nullable = 'NO' then 'auth_user_id is still NOT NULL; migration 003 is intended to drop NOT NULL.'
      else 'public.peka_participants.auth_user_id was not found.'
    end
  from participant_email_nullability n

  union all

  select
    'participants_unique_lower_email',
    case when i.found_index then 'PASS' else 'STOP' end,
    case when i.found_index
      then 'A valid, ready, non-partial unique expression index on lower(email) exists.'
      else 'Expected unique expression index on lower(email) is missing or invalid.'
    end
  from participant_email_index i

  union all

  select
    'participants_duplicate_lower_email',
    case when d.duplicate_groups = 0 then 'PASS' else 'STOP' end,
    format('Duplicate groups: %s; excess participant rows: %s.', d.duplicate_groups, d.extra_rows)
  from email_duplicates d

  union all

  select
    'sessions_unique_participant_quiz_type',
    case when c.found_constraint then 'PASS' else 'STOP' end,
    case when c.found_constraint
      then 'Unique constraint on (participant_id, quiz_type) exists.'
      else 'Expected unique constraint on (participant_id, quiz_type) is missing.'
    end
  from participant_attempt_constraint c

  union all

  select
    'sessions_duplicate_participant_quiz_type',
    case when d.duplicate_groups = 0 then 'PASS' else 'STOP' end,
    format('Duplicate groups: %s; excess session rows: %s.', d.duplicate_groups, d.extra_rows)
  from session_duplicates d

  union all

  select
    'function_signature_' || f.function_name,
    case when f.signature_matches then 'PASS' else 'EXPECTED_CHANGE' end,
    case when f.signature_matches
      then 'Expected argument types, argument names, and return type are present.'
      else 'Target signature is not installed yet; migration 003 is intended to create or replace it. Inspect any same-name overloads and dependencies before applying.'
    end
  from function_check f

  union all

  select
    'function_security_' || f.function_name,
    case when f.secure_definer_configuration then 'PASS' else 'EXPECTED_CHANGE' end,
    case when f.secure_definer_configuration
      then 'Function is SECURITY DEFINER with search_path=pg_catalog.'
      else 'Target SECURITY DEFINER/search_path configuration is not present; migration 003 is intended to install it.'
    end
  from function_check f

  union all

  select
    'advance_peka_quiz_dependencies_preserved',
    case
      when d.matching_functions = 1 then 'PASS'
      else 'STOP'
    end,
    case
      when d.matching_functions = 1 then format(
        'Migration 003 now replaces the existing function in place, preserving its %s catalog dependency row(s).',
        d.dependent_objects
      )
      else 'The expected advance_peka_quiz function is missing; stop and inspect migration history before applying migration 003.'
    end
  from advance_function_dependencies d

  union all

  select
    'completion_outbox_rls',
    case
      when a.oid is null then 'NOT APPLICABLE'
      when a.relrowsecurity then 'PASS'
      else 'EXPECTED_CHANGE'
    end,
    case
      when a.oid is null then 'Table is absent.'
      when a.relrowsecurity then 'Row-level security is enabled.'
      else 'Row-level security is not enabled; migration 003 is intended to enable it.'
    end
  from outbox_access a

  union all

  select
    'completion_outbox_anon_authenticated_privileges',
    case
      when a.oid is null then 'NOT APPLICABLE'
      when not a.exposed_to_client_roles then 'PASS'
      else 'EXPECTED_CHANGE'
    end,
    case
      when a.oid is null then 'Table is absent.'
      when not a.exposed_to_client_roles then 'No table-level privileges detected for anon or authenticated.'
      else 'A client-role privilege is present; migration 003 is intended to revoke table-level privileges from anon, authenticated, and PUBLIC.'
    end
  from outbox_access a
) checks
order by check_name;
