import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Set them in .env.local for local dev, " +
      "or in your Vercel/Netlify project's Environment Variables for deployment."
  );
}

export const supabase = createClient(url || "", anonKey || "");
