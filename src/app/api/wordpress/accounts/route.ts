// src/app/api/wordpress/accounts/route.ts

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '../../../../lib/supabaseAdmin';

export const runtime = 'edge';

export async function GET(request: Request) {
  const userId = new URL(request.url).searchParams.get('userId');
  if (!userId) {
    return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
  }
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from('wp_accounts')
    .select('id, site_url, username')
    .eq('user_id', userId);

  if (error) {
    console.error('[accounts] Supabase error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ accounts: data });
}
