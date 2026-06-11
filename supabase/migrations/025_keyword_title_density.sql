-- 025_keyword_title_density.sql
-- Title Density (from H10 Cerebro imports, PR #176/#178): how many page-1 competitors have the
-- EXACT phrase in their TITLE. TD 0-2 with real volume = an outsized, low-competition title /
-- Item-Highlights win ("college essentials" 33k/mo had TD=0 in the PO's Cerebro run). Nullable —
-- native SQP/Jungle Scout keywords don't measure it.

ALTER TABLE keyword_analysis ADD COLUMN IF NOT EXISTS title_density integer;
