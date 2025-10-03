// src/app/api/wordpress/publish/route.ts

import { NextResponse } from 'next/server';
import { getSupabaseAdmin }  from '../../../../lib/supabaseAdmin';
import { decrypt }         from '../../../../utils/encryption';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // 1) Pull accountId, title & content from the request body
  const { userId, accountId, title, content } = await req.json();
  if (!userId || !accountId || !title || !content) {
    return NextResponse.json(
      { error: 'Missing userId, accountId, title or content' },
      { status: 400 }
    );
  }

  // 2) Fetch stored WP credentials
  const supabaseAdmin = getSupabaseAdmin();
  const { data: account, error } = await supabaseAdmin
    .from('wp_accounts')
    .select('site_url, username, encrypted_password, footer_html')
    .eq('id', accountId)
    .eq('user_id', userId)
    .single();

  if (error || !account) {
    return NextResponse.json(
      { error: 'WordPress credentials not found' },
      { status: 404 }
    );
  }

  // 3) Decrypt the application password
  const decryptedPassword = decrypt(account.encrypted_password);

  // ← DEBUG: log out what we decrypted

  // 4) Build Basic Auth header
  const basicAuth =
    typeof Buffer !== 'undefined'
      ? Buffer.from(`${account.username}:${decryptedPassword}`).toString('base64')
      : btoa(`${account.username}:${decryptedPassword}`);

  // ← DEBUG: log out the header we’ll send

  // Append any saved footer HTML
  const finalContent = content + (account.footer_html || '');

  // 5) POST to WP as a draft
  const apiUrl = account.site_url.replace(/\/$/, '') + '/wp-json/wp/v2/posts';
  let wpRes: Response;
  try {
    wpRes = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        title, // user-supplied title
        content: finalContent, // full HTML body
        status: 'draft',
      }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to reach WordPress', details: String(err) },
      { status: 502 }
    );
  }

  const text = await wpRes.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}
  if (!wpRes.ok) {
    return NextResponse.json(
      { error: data?.message || 'WP API error', details: text },
      { status: wpRes.status }
    );
  }
  return NextResponse.json({ post: data });
}
