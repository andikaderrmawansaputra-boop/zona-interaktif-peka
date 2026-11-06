create table public.quiz_data_results (
  id uuid primary key default gen_random_uuid(),
  correct_answers smallint not null
    check (correct_answers between 0 and 15),
  total_questions smallint not null default 15
    check (total_questions = 15),
  score_percent smallint not null
    check (
      score_percent between 0 and 100
      and score_percent = round(100.0 * correct_answers / total_questions)
    ),
  created_at timestamptz not null default now()
);

alter table public.quiz_data_results enable row level security;

revoke all on public.quiz_data_results from public, anon, authenticated;
grant insert (correct_answers, total_questions, score_percent)
  on public.quiz_data_results to anon;

create policy quiz_data_results_anon_insert
  on public.quiz_data_results
  for insert
  to anon
  with check (true);
