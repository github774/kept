-- Immune memory: cross-run case files (one row per retired agent) with a pgvector embedding.
-- Written by orchestrator/src/memory/immune.ts at retire (upsert on id), read at run start via match_cases.
-- Idempotent: safe to run more than once.

create extension if not exists vector with schema extensions;

create table if not exists public.cases (
  id          text primary key,                -- case id: <runId>.<slot>.g<gen>
  lesson      text,                            -- null = lesson writer said NO_LESSON
  category    text not null,                   -- FailureCategory
  task        text not null,                   -- task id, e.g. invoice_parser
  "function"  text not null default '',        -- the subtask (task.json function name)
  run_id      text not null,
  library_id  text not null,
  created_at  timestamptz not null default now(),
  embedding   extensions.vector(256),          -- text-embedding-3-small @ 256d (config/models.json)
  revoked     boolean not null default false   -- a revoked (poisoned) case is never recalled
);

create index if not exists cases_task_idx on public.cases (task, created_at);
create index if not exists cases_embedding_hnsw on public.cases using hnsw (embedding extensions.vector_cosine_ops);

-- Server-side only: RLS on with no policies, so anon/publishable keys see nothing; the secret
-- (service_role) key bypasses RLS.
alter table public.cases enable row level security;

-- Top-k lessons for a task, nearest to query_embedding first (cosine).
create or replace function public.match_cases(query_embedding extensions.vector(256), task text, k int default 3)
returns table (
  id text,
  lesson text,
  category text,
  "function" text,
  run_id text,
  library_id text,
  created_at timestamptz,
  similarity double precision
)
language sql stable
set search_path = public, extensions
as $$
  select c.id, c.lesson, c.category, c."function", c.run_id, c.library_id, c.created_at,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.cases c
  where c.task = match_cases.task
    and c.lesson is not null and c.lesson <> ''
    and not c.revoked
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit least(greatest(k, 1), 50);
$$;

revoke execute on function public.match_cases(extensions.vector, text, int) from public, anon, authenticated;
grant execute on function public.match_cases(extensions.vector, text, int) to service_role;
