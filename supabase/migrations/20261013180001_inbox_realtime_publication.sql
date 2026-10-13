-- ==============================================================================
-- MIGRATION: 20261013180001_inbox_realtime_publication.sql
-- Module: Omnichannel Inbox - Near-Realtime Live Updates
--
-- Objective:
-- Enable Supabase Realtime publication on public.interactions and public.conversations
-- with REPLICA IDENTITY FULL for instant live events to authenticated client subscribers.
-- Preserves all existing Row Level Security (RLS) policies.
-- ==============================================================================

DO $$
BEGIN
  -- Add public.interactions to supabase_realtime if not already present
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'interactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.interactions;
  END IF;

  -- Add public.conversations to supabase_realtime if not already present
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
  END IF;
END $$;

ALTER TABLE public.conversations REPLICA IDENTITY FULL;
ALTER TABLE public.interactions REPLICA IDENTITY FULL;
