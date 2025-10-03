import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query } = body;

    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      );
    }

    // Proxy request to your recipe server
    const recipeServerUrl = process.env.RECIPE_SERVER_URL || 'https://animated-spoon.onrender.com';
    
    const response = await fetch(`${recipeServerUrl}/api/recipe-query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Recipe server responded with status: ${response.status}`);
    }

    const data = await response.json();
    
    return NextResponse.json({
      content: data.article || data.content,
      sources: data.sources || [],
      success: true
    });

  } catch (error) {
    console.error('Recipe generation error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to generate recipe article',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
