-- =====================================================================
-- Meeting Signs — Supabase / Postgres schema
-- Run this in your Supabase project's SQL Editor before setting
-- DB_BACKEND=supabase. Integer 0/1 flags mirror the SQLite backend so
-- application logic is identical across both.
-- =====================================================================

create table if not exists admins (
  id            text primary key,
  email         text not null unique,
  password_hash text not null,
  name          text not null default '',
  role          text not null default 'admin',
  failed_logins integer not null default 0,
  locked_until  bigint,
  created_at    bigint not null
);

create table if not exists sessions (
  id          text primary key,
  admin_id    text not null references admins(id) on delete cascade,
  csrf_token  text not null,
  expires_at  bigint not null,
  created_at  bigint not null,
  ip          text,
  user_agent  text
);
create index if not exists idx_sessions_admin on sessions(admin_id);

create table if not exists meetings (
  id                    text primary key,
  slug                  text not null unique,
  owner_id              text not null references admins(id) on delete cascade,
  title                 text not null,
  description           text not null default '',
  location_name         text not null default '',
  venue                 text not null default '',
  latitude              double precision,
  longitude             double precision,
  radius_meters         integer not null default 150,
  geofence_enabled      integer not null default 1,
  max_accuracy_meters   integer not null default 100,
  starts_at             bigint,
  ends_at               bigint,
  is_open               integer not null default 1,
  passcode_hash         text,
  require_unique_email  integer not null default 1,
  limit_one_per_device  integer not null default 1,
  collect_ip            integer not null default 1,
  notify_attendee_email integer not null default 0,
  notify_attendee_sms   integer not null default 0,
  notify_owner_email    integer not null default 0,
  notify_owner_sms      integer not null default 0,
  owner_notify_email    text not null default '',
  owner_notify_phone    text not null default '',
  fields_json           text not null default '[]',
  status                text not null default 'active',
  created_at            bigint not null,
  updated_at            bigint not null
);
create index if not exists idx_meetings_owner on meetings(owner_id);

create table if not exists signins (
  id              text primary key,
  meeting_id      text not null references meetings(id) on delete cascade,
  data_json       text not null default '{}',
  email           text,
  latitude        double precision,
  longitude       double precision,
  accuracy        double precision,
  distance_meters double precision,
  within_geofence integer not null default 0,
  ip              text,
  user_agent      text,
  device_hash     text,
  flagged         integer not null default 0,
  flag_reason     text,
  created_at      bigint not null
);
create index if not exists idx_signins_meeting on signins(meeting_id);
create index if not exists idx_signins_email on signins(meeting_id, email);
create index if not exists idx_signins_device on signins(meeting_id, device_hash);

create table if not exists org_settings (
  owner_id    text primary key references admins(id) on delete cascade,
  org_name    text not null default '',
  address     text not null default '',
  contact     text not null default '',
  footer_text text not null default '',
  logo_b64    text,
  logo_mime   text,
  logo_w      integer,
  logo_h      integer,
  updated_at  bigint
);

create table if not exists contact_messages (
  id         text primary key,
  name       text not null,
  email      text not null,
  phone      text,
  subject    text,
  message    text not null,
  ip         text,
  created_at bigint not null
);

create table if not exists audit_log (
  id         text primary key,
  actor      text,
  action     text not null,
  target     text,
  detail     text,
  ip         text,
  created_at bigint not null
);

-- The server uses the service-role key and bypasses RLS. We still enable RLS
-- with no public policies so the anon/public key cannot read these tables.
alter table admins           enable row level security;
alter table sessions         enable row level security;
alter table meetings         enable row level security;
alter table signins          enable row level security;
alter table org_settings     enable row level security;
alter table contact_messages enable row level security;
alter table audit_log        enable row level security;
