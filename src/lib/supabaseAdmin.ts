import { createClient } from "@supabase/supabase-js";

let supabaseAdmin: any = null;

export function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase environment variables are not configured');
    }
    
    supabaseAdmin = createClient(supabaseUrl, supabaseKey);
  }
  return supabaseAdmin;
}