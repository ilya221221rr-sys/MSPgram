// ============================================================
//  НАСТРОЙКА MSPgram — сюда вставляются ключи из Supabase
//
//  1) Зайди на https://supabase.com и создай проект (см. SETUP.md)
//  2) Project Settings → API:
//       - скопируй "Project URL"      (вида https://xxxx.supabase.co)
//       - скопируй ключ "anon public" (длинная строка)
//  3) Замени ПОМЕНЯЙ_МЕНЯ ниже и сделай Commit в GitHub
// ============================================================

window.MSP_CONFIG = {
  supabaseUrl: "ПОМЕНЯЙ_МЕНЯ",       // например: https://abcdefghijk.supabase.co
  supabaseAnonKey: "ПОМЕНЯЙ_МЕНЯ",   // ключ anon public — это НЕ секретный ключ
};
