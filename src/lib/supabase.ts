import { createBrowserClient } from '@supabase/ssr';

let supabase: any = null;

export function getSupabase() {
  if (!supabase) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase environment variables are not configured');
    }
    
    supabase = createBrowserClient(supabaseUrl, supabaseKey);
  }
  return supabase;
}
