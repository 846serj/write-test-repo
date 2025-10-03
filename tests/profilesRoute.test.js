import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/profiles/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const uuidMatch = tsCode.match(/const UUID_REGEX[\s\S]*?;/);
const jsonErrorMatch = tsCode.match(/function jsonError[\s\S]*?\n}\n/);
const mapErrorMatch = tsCode.match(/function mapSupabaseError[\s\S]*?\n}\n/);
const getHandlerMatch = tsCode.match(/export async function GET[\s\S]*?\n}\n/);
const handlerMatch = tsCode.match(
  /function createProfilesPostHandler[\s\S]*?\n}\n\nexport const POST = createProfilesPostHandler\(\);/
);

if (!uuidMatch || !jsonErrorMatch || !mapErrorMatch || !getHandlerMatch || !handlerMatch) {
  throw new Error('Failed to extract handler from route file');
}

const snippet = `
let supabaseAdmin = undefined;
const extractProfile = undefined;
const normalizeSiteUrl = undefined;
const normalizeProfile = undefined;
const buildProfileHeadlineQuery = undefined;
const getProfileQuotaTotal = undefined;

const NextResponse = {
  json(body, init) {
    return {
      body,
      status: init?.status ?? 200,
      async json() {
        return body;
      },
    };
  },
};
${uuidMatch[0]}
${jsonErrorMatch[0]}
${mapErrorMatch[0]}
${getHandlerMatch[0].replace('export async function', 'async function')}
${handlerMatch[0]
  .replace('export function', 'function')
  .replace(/\n\nexport const POST[\s\S]*/, '')}
export function __setSupabaseAdmin(value) {
  supabaseAdmin = value;
}
export { createProfilesPostHandler, GET };
`;

const jsCode = ts.transpileModule(snippet, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;

const moduleUrl =
  'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');

const { createProfilesPostHandler, GET, __setSupabaseAdmin } = await import(moduleUrl);

function createRequest(body) {
  return {
    async json() {
      return body;
    },
  };
}

test('GET rejects invalid userId format', async () => {
  let supabaseCalls = 0;
  __setSupabaseAdmin({
    from() {
      supabaseCalls += 1;
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: null, error: null }),
              };
            },
          };
        },
      };
    },
  });

  try {
    const response = await GET({
      nextUrl: {
        searchParams: new URLSearchParams([['userId', 'not-a-uuid']]),
      },
    });

    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.strictEqual(body.error, 'Invalid userId format');
    assert.strictEqual(supabaseCalls, 0);
  } finally {
    __setSupabaseAdmin(undefined);
  }
});

test('POST rejects invalid userId format', async () => {
  let getUserCalls = 0;
  const handler = createProfilesPostHandler({
    supabaseAdmin: {
      auth: {
        admin: {
          async getUserById() {
            getUserCalls += 1;
            return { data: { user: {} }, error: null };
          },
        },
      },
      from() {
        throw new Error('should not be called');
      },
    },
    extractProfile: async () => ({}),
    normalizeSiteUrl: (url) => url,
    normalizeProfile: (profile) => profile,
    buildProfileHeadlineQuery: () => 'query',
    getProfileQuotaTotal: () => 1,
  });

  const response = await handler(
    createRequest({
      userId: 'not-a-uuid',
      siteUrl: 'https://example.com',
      rawText: 'text',
    })
  );

  assert.strictEqual(response.status, 400);
  const body = await response.json();
  assert.strictEqual(body.error, 'Invalid userId format');
  assert.strictEqual(getUserCalls, 0);
});

test('POST returns 404 when Supabase user is missing', async () => {
  let getUserCalls = 0;
  const handler = createProfilesPostHandler({
    supabaseAdmin: {
      auth: {
        admin: {
          async getUserById() {
            getUserCalls += 1;
            return { data: { user: null }, error: null };
          },
        },
      },
      from() {
        throw new Error('should not be called when user missing');
      },
    },
    extractProfile: async () => ({}),
    normalizeSiteUrl: (url) => url,
    normalizeProfile: (profile) => profile,
    buildProfileHeadlineQuery: () => 'query',
    getProfileQuotaTotal: () => 1,
  });

  const response = await handler(
    createRequest({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      siteUrl: 'https://example.com',
      rawText: 'text',
    })
  );

  assert.strictEqual(response.status, 404);
  const body = await response.json();
  assert.strictEqual(body.error, 'User account not found');
  assert.strictEqual(getUserCalls, 1);
});

test('POST maps Supabase error codes to descriptive responses', async () => {
  const validRequest = createRequest({
    userId: '123e4567-e89b-12d3-a456-426614174000',
    siteUrl: 'https://example.com',
    rawText: 'text',
  });

  const cases = [
    { code: '23503', status: 404, message: 'User account not found' },
    { code: '23505', status: 409, message: 'A profile already exists for this user' },
    { code: '42P01', status: 424, message: 'Profile storage is not available' },
    { code: '42501', status: 403, message: 'Service is not authorized to store profiles' },
  ];

  for (const { code, status, message } of cases) {
    let upsertCalls = 0;
    const handler = createProfilesPostHandler({
      supabaseAdmin: {
        auth: {
          admin: {
            async getUserById() {
              return { data: { user: {} }, error: null };
            },
          },
        },
        from() {
          return {
            upsert() {
              return {
                select() {
                  return {
                    async single() {
                      upsertCalls += 1;
                      return {
                        data: null,
                        error: {
                          code,
                          message: 'db error',
                          details: 'details',
                          hint: 'hint',
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      },
      extractProfile: async () => ({}),
      normalizeSiteUrl: (url) => url,
      normalizeProfile: (profile) => profile,
      buildProfileHeadlineQuery: () => 'query',
      getProfileQuotaTotal: () => 1,
    });

    const response = await handler(validRequest);
    const body = await response.json();

    assert.strictEqual(upsertCalls, 1, `upsert should be called for code ${code}`);
    assert.strictEqual(response.status, status, `unexpected status for code ${code}`);
    assert.strictEqual(body.error, message, `unexpected message for code ${code}`);
    assert.ok(body.supabase, 'should include supabase error details in test env');
    assert.strictEqual(body.supabase.code, code);
  }
});
