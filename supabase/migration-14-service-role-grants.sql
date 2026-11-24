-- ============================================================
--  Миграция 14: права service_role на таблицы (пуш-функции).
--  В этой БД default privileges не давали service_role права
--  arwd → edge-функции получали "permission denied" и пуши
--  молча не отправлялись (404 message not found).
--  Безопасно запускать повторно.
-- ============================================================
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage on all sequences in schema public to service_role;
