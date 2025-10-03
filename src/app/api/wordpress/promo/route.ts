import { NextResponse } from 'next/server';
import { supabaseAdmin } from '../../../../lib/supabaseAdmin';

export const runtime = 'edge';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = url.searchParams.get('userId');
  const accountId = url.searchParams.get('accountId');
  if (!userId || !accountId) {
    return NextResponse.json({ error: 'Missing userId or accountId' }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin
    .from('wp_accounts')
    .select('footer_html')
    .eq('id', accountId)
    .eq('user_id', userId)
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ footer_html: data?.footer_html || '' });
}

export async function POST(req: Request) {
  const { userId, accountId, footer_html } = await req.json();
  if (!userId || !accountId) {
    return NextResponse.json({ error: 'Missing userId or accountId' }, { status: 400 });
  }
  const { error } = await supabaseAdmin
    .from('wp_accounts')
    .update({ footer_html })
    .eq('id', accountId)
    .eq('user_id', userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
