-- search_results: drop the per-row foreign key to candidates (DECISIONS.md: "search_results write cost").
--
-- Only complete_search writes this table, and its ids come straight from public.candidates via
-- match_candidates; candidates are never deleted (the seed only upserts, and no API role can write
-- them). The check cost ~20 µs a row: completing a 4,676-result search took 194 ms with it and
-- 95 ms without. The (search_id, company_id) key stays: it carries the cascade from searches and
-- keeps results under their search's company.
alter table public.search_results drop constraint search_results_candidate_id_fkey;
