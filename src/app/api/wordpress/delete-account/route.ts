import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '../../../../lib/supabaseAdmin';

export async function DELETE(req: Request) {
  const { userId, accountId } = await req.json();
  if (!userId || !accountId) {
    return NextResponse.json(
      { error: 'Missing userId or accountId' },
      { status: 400 }
    );
  }

  // delete the row
  const supabaseAdmin = getSupabaseAdmin();
  const { error } = await supabaseAdmin
    .from('wp_accounts')
    .delete()
    .eq('id', accountId)
    .eq('user_id', userId);

  if (error) {
    return NextResponse.json(
      { error: error.message || 'Delete failed' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
