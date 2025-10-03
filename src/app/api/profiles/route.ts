import { NextRequest, NextResponse } from 'next/server';
import { getOpenAI } from '../../../lib/openai';
import { getSupabaseAdmin } from '../../../lib/supabaseAdmin';
import {
  buildProfileHeadlineQuery,
  getProfileQuotaTotal,
  normalizeProfile,
  normalizeSiteUrl,
} from '../../../utils/profile';
import { NormalizedSiteProfile } from '../../../types/profile';

const EXTRACTION_PROMPT =
  'From the following user text, extract: language, taxonomy (IAB/IPTC-like tags), must_include_keywords, nice_to_have_keywords, must_exclude_keywords, entities_focus, audience, tone, and a per-category quota summing to 100 headlines. Return valid JSON.';

const MODEL = process.env.HEADLINE_PROFILE_MODEL || 'gpt-4o-mini';

type PostBody = {
  userId?: string;
  siteUrl?: string;
  rawText?: string;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function mapSupabaseError(code: string | undefined) {
  switch (code) {
    case '23503':
      return { status: 404, message: 'User account not found' } as const;
    case '23505':
      return {
        status: 409,
        message: 'A profile already exists for this user',
      } as const;
    case '42P01':
      return {
        status: 424,
        message: 'Profile storage is not available',
      } as const;
    case '42501':
      return {
        status: 403,
        message: 'Service is not authorized to store profiles',
      } as const;
    default:
      return null;
  }
}

async function extractProfile(rawText: string): Promise<NormalizedSiteProfile> {
  const openai = getOpenAI();
  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You turn unstructured editorial briefs into consistent JSON site profiles that downstream services can consume.',
      },
      {
        role: 'user',
        content: `${EXTRACTION_PROMPT}\n\n${rawText}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Model returned no content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error('Model response was not valid JSON');
  }

  return normalizeProfile(parsed);
}

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId')?.trim();
  if (!userId) {
    return jsonError('Missing userId');
  }
  if (!UUID_REGEX.test(userId)) {
    return jsonError('Invalid userId format');
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from('site_profiles')
    .select('site_url, raw_text, profile')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[profiles] failed to load profile', error);
    return jsonError('Failed to load profile', 500);
  }

  if (!data) {
    return NextResponse.json({ profile: null });
  }

  let normalizedProfile: NormalizedSiteProfile;
  try {
    normalizedProfile = normalizeProfile(data.profile);
  } catch (error) {
    console.error('[profiles] stored profile invalid', error);
    return NextResponse.json({ profile: null });
  }

  return NextResponse.json({
    profile: normalizedProfile,
    siteUrl: data.site_url,
    rawText: data.raw_text,
    headlineQuery: buildProfileHeadlineQuery(normalizedProfile),
    quotaTotal: getProfileQuotaTotal(normalizedProfile),
  });
}

type ProfilesDependencies = {
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>;
  extractProfile: typeof extractProfile;
  normalizeSiteUrl: typeof normalizeSiteUrl;
  normalizeProfile: typeof normalizeProfile;
  buildProfileHeadlineQuery: typeof buildProfileHeadlineQuery;
  getProfileQuotaTotal: typeof getProfileQuotaTotal;
};

function createProfilesPostHandler(
  overrides: Partial<ProfilesDependencies> = {}
) {
  const {
    supabaseAdmin: supabaseClient = getSupabaseAdmin(),
    extractProfile: profileExtractor = extractProfile,
    normalizeSiteUrl: siteUrlNormalizer = normalizeSiteUrl,
    normalizeProfile: profileNormalizer = normalizeProfile,
    buildProfileHeadlineQuery: headlineQueryBuilder = buildProfileHeadlineQuery,
    getProfileQuotaTotal: quotaCalculator = getProfileQuotaTotal,
  } = overrides;

  return async function POST(request: NextRequest) {
    let body: PostBody;
    try {
      body = await request.json();
    } catch {
      return jsonError('Invalid JSON body');
    }

    const userId = body.userId?.trim();
    const siteUrlRaw = body.siteUrl?.trim();
    const rawText = body.rawText?.trim();

    if (!userId) {
      return jsonError('Missing userId');
    }
    if (!UUID_REGEX.test(userId)) {
      return jsonError('Invalid userId format');
    }
    if (!siteUrlRaw) {
      return jsonError('Missing siteUrl');
    }
    if (!rawText) {
      return jsonError('Missing profile text');
    }

    const {
      data: userRecord,
      error: userLookupError,
    } = await supabaseClient.auth.admin.getUserById(userId);

    if (userLookupError) {
      console.error('[profiles] failed to load user', userLookupError);
      return jsonError('Failed to verify user account', 502);
    }

    const user =
      (userRecord && 'user' in userRecord ? userRecord.user : userRecord) ??
      null;

    if (!user) {
      return jsonError('User account not found', 404);
    }

    let normalizedSiteUrl: string;
    try {
      normalizedSiteUrl = siteUrlNormalizer(siteUrlRaw);
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : 'Invalid site URL provided'
      );
    }

    let profile: NormalizedSiteProfile;
    try {
      profile = await profileExtractor(rawText);
    } catch (error) {
      console.error('[profiles] extraction failed', error);
      return jsonError(
        error instanceof Error ? error.message : 'Failed to normalize profile',
        502
      );
    }

    const payload = {
      user_id: userId,
      site_url: normalizedSiteUrl,
      raw_text: rawText,
      profile,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabaseClient
      .from('site_profiles')
      .upsert(payload, { onConflict: 'user_id' })
      .select('site_url, raw_text, profile')
      .single();

    if (error) {
      const supabaseError = {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      };

      console.error('[profiles] failed to store profile', {
        context: {
          userId,
          siteUrl: normalizedSiteUrl,
          rawTextLength: rawText.length,
        },
        supabaseError,
      });

      const mapped = mapSupabaseError(error.code);
      const status = mapped?.status ?? 500;
      const message = mapped?.message ?? 'Failed to store profile';

      const errorBody: Record<string, unknown> = { error: message };
      if (process.env.NODE_ENV !== 'production') {
        errorBody.supabase = supabaseError;
      }

      return NextResponse.json(errorBody, { status });
    }

    const normalizedProfile = profileNormalizer(data.profile);

    return NextResponse.json({
      profile: normalizedProfile,
      siteUrl: data.site_url,
      rawText: data.raw_text,
      headlineQuery: headlineQueryBuilder(normalizedProfile),
      quotaTotal: quotaCalculator(normalizedProfile),
    });
  };
}

export const POST = createProfilesPostHandler();
