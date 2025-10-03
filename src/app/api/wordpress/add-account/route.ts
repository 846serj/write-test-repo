// src/app/api/wordpress/add-account/route.ts

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '../../../../lib/supabaseAdmin';
import { encrypt } from '../../../../utils/encryption';

export const runtime = 'edge';

export async function POST(request: Request) {
  try {
    const { userId, siteUrl, username, password } = await request.json();

    // Validate input
    if (!userId || !siteUrl || !username || !password) {
      return NextResponse.json(
        { error: 'Missing userId, siteUrl, username, or password' },
        { status: 400 }
      );
    }

    // Normalize URL (no trailing slash)
    const normalizedUrl = siteUrl.replace(/\/+$/, '');

    // Verify WP credentials
    const authHeader = 'Basic ' + btoa(`${username}:${password}`);
    const wpRes = await fetch(
      `${normalizedUrl}/wp-json/wp/v2/users/me`,
      { headers: { Authorization: authHeader } }
    );
    if (!wpRes.ok) {
      return NextResponse.json(
        { error: 'Invalid WordPress credentials' },
        { status: 401 }
      );
    }

    // Encrypt password
    const encrypted = encrypt(password);

    // Store in Supabase
    const supabaseAdmin = getSupabaseAdmin();
    const { error } = await supabaseAdmin
      .from('wp_accounts')
      .insert({
        user_id: userId,
        site_url: normalizedUrl,
        username,
        encrypted_password: encrypted,
      });
    if (error) {
      console.error('[add-account] Supabase insert error:', error);
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    // Success!
    return NextResponse.json({ success: true });

  } catch (err) {
    console.error('[add-account] unexpected error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
