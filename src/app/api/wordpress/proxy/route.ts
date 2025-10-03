import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '../../../../lib/supabaseAdmin';
import { decrypt } from '../../../../utils/encryption';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return handleRequest(req, 'GET');
}
export async function POST(req: NextRequest) {
  return handleRequest(req, 'POST');
}
export async function PUT(req: NextRequest) {
  return handleRequest(req, 'PUT');
}

async function handleRequest(req: NextRequest, method: string) {
  try {
    const { searchParams } = new URL(req.url);
    const urlParam = searchParams.get('url');
    const userId = searchParams.get('userId');
    const accountId = searchParams.get('accountId');
    let targetUrl = urlParam;
    let authHeader = req.headers.get('authorization');  // e.g. "Basic abc123..."
    let contentType = req.headers.get('content-type');

    // 1. If accountId & userId are provided, retrieve credentials from DB and construct Basic auth
    if (accountId && userId) {
      const supabaseAdmin = getSupabaseAdmin();
      const { data: account, error } = await supabaseAdmin
        .from('wp_accounts')
        .select('site_url, username, encrypted_password, footer_html')
        .eq('id', accountId).eq('user_id', userId)
        .single();
      if (error || !account) {
        return NextResponse.json({ error: 'WordPress account not found' }, { status: 404 });
      }
      const decryptedPassword = decrypt(account.encrypted_password);
      const basicAuth = Buffer.from(`${account.username}:${decryptedPassword}`).toString('base64');
      authHeader = `Basic ${basicAuth}`;

      // If no explicit URL provided, default to the posts endpoint of the site
      if (!targetUrl) {
        const siteBase = account.site_url.replace(/\/$/, '');
        targetUrl = siteBase + '/wp-json/wp/v2/posts';
        if (method === 'GET') {
          // For GET, you might append query params to list posts (including drafts)
          targetUrl += '?context=edit&per_page=10';
        }
      }

      // If this is a POST request with JSON content, append the account’s footer HTML to the post content
      if (method === 'POST' && contentType?.includes('application/json')) {
        const bodyText = await req.text();
        try {
          const postData = JSON.parse(bodyText);
          if (postData.content) {
            postData.content += account.footer_html || '';  // append footer HTML if any
          }
          if (!postData.status) {
            postData.status = 'draft';  // ensure the post is saved as draft (same as original behavior)
          }
          // Replace the request body with the updated content including footer
          contentType = 'application/json';
          req = new NextRequest(req.url, {
            method: req.method,
            headers: { 'Content-Type': contentType, 'Authorization': authHeader },
            body: JSON.stringify(postData)
          });
        } catch (e) {
          console.error('Footer append failed, sending content unchanged:', e);
        }
      }
    }

    // 2. Validate we have a URL and auth header at this point
    if (!targetUrl || !authHeader) {
      return NextResponse.json({ error: 'Missing target URL or authorization credentials' }, { status: 400 });
    }

    // 3. Prepare headers for the outgoing request to WordPress
    const forwardHeaders: Record<string, string> = {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate'
    };
    if (contentType) {
      forwardHeaders['Content-Type'] = contentType;
    }

    // 4. Set up fetch options, including forwarding the request body if present
    const fetchOptions: any = { method, headers: forwardHeaders };
    if (method === 'POST' || method === 'PUT') {
      if (contentType?.includes('multipart/form-data')) {
        fetchOptions.body = req.body;
        fetchOptions.duplex = 'half';
      } else if (req.body) {
        fetchOptions.body = req.body;
        fetchOptions.duplex = 'half'; // body was replaced above if JSON with footer
      } else if (contentType?.includes('application/json')) {
        fetchOptions.body = JSON.stringify(await req.json());
      } else {
        fetchOptions.body = await req.text();
      }
    }

    // 5. Forward the request to the WordPress REST API
    const wpResponse = await fetch(targetUrl, fetchOptions);

    // 6. Handle non-OK responses (errors from WordPress)
    if (!wpResponse.ok) {
      const errorText = await wpResponse.text();
      console.error('Proxy fetch error:', {
        status: wpResponse.status, statusText: wpResponse.statusText, response: errorText
      });
      return NextResponse.json(
        { error: errorText || 'WordPress API error' },
        { status: wpResponse.status }
      );
    }

    // 7. On success, forward the JSON data back to the client
    const data = await wpResponse.json();
    // Include any relevant headers from WP (e.g., pagination) in the response
    const responseHeaders = new Headers();
    ['x-wp-total', 'x-wp-totalpages', 'content-type'].forEach(h => {
      const val = wpResponse.headers.get(h);
      if (val) responseHeaders.set(h, val);
    });
    responseHeaders.set('Cache-Control', 'no-store, no-cache');
    return NextResponse.json(data, { headers: responseHeaders });
  } catch (err: any) {
    console.error('Proxy request failed:', err);
    return NextResponse.json(
      { error: 'Proxy request failed: ' + err.message },
      { status: 500 }
    );
  }
}
