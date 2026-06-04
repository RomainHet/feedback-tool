-- Run this in the Supabase SQL editor.

create table if not exists comments (
  id          uuid primary key default gen_random_uuid(),
  project_id  text not null,
  pathname    text not null,
  x_pct       numeric not null,
  y_pct       numeric not null,
  text        text not null,
  author      text,
  created_at  timestamptz not null default now()
);

create index if not exists comments_project_path_idx
  on comments (project_id, pathname, created_at);

-- The API route uses the service-role key, so RLS can stay off for the
-- prototype. If you want to expose the table directly via PostgREST instead,
-- enable RLS and add policies before going beyond a prototype.
