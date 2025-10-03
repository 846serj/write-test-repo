import { NextRequest, NextResponse } from 'next/server';
import { findRecipes } from '../../../lib/findRecipes';

export async function POST(req: NextRequest) {
  try {
    const { headline, count, minSimilarity } = await req.json();
    if (!headline || typeof headline !== 'string') {
      return NextResponse.json({ error: 'headline is required' }, { status: 400 });
    }

    const results = await findRecipes(headline, count, minSimilarity);
    return NextResponse.json(results);
  } catch (err) {
    console.error('findRecipes error', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
