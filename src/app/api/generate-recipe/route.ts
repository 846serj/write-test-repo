import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { getOpenAI } from '../../../lib/openai';
import { getCenterCropRegion, getCroppedImg } from '../../../utils/imageCrop';
import { findRecipes } from '../../../lib/findRecipes';
import type { RecipeResult } from '../../../types/api';
import { formatNumberingPrefix } from '../../../utils/formatNumberingPrefix';

export async function POST(request: NextRequest) {
  try {
    // Parse request JSON for necessary fields
    const body = await request.json();
    const title: string = body.title || '';
    const wordsPerItem: number = body.wordsPerItem ? parseInt(body.wordsPerItem) : 100;
    const numberingFormat: string = body.numberingFormat || '1.'; // e.g. "1." or "1)" or "none"
    const itemCount: number | undefined = body.itemCount ? parseInt(body.itemCount) : undefined;

    // Ensure Airtable environment variables are set
    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_TABLE_NAME) {
      return NextResponse.json({ error: 'Airtable environment variables not configured' }, { status: 500 });
    }

    const openai = getOpenAI();

      const baseUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(
        process.env.AIRTABLE_TABLE_NAME as string
      )}`;
      const headers = { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` };

      const count = itemCount && itemCount > 0 ? itemCount : 10;

      let filterFormula: string | null = null;
      let fallbackResults: RecipeResult[] | undefined;

      if (!title) {
        return NextResponse.json({ error: 'title is required' }, { status: 400 });
      }

      try {
        const keywordPrompt = `Extract 3-5 key categories, tags, flavors, or dish types from this recipe roundup title: '${title}'. Focus on the main theme, such as flavors (e.g., chocolate, vanilla) and types (e.g., desserts, cakes). Output as a comma-separated list.`;
        const keywordRes = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: keywordPrompt }],
          max_tokens: 50,
        });
        const keywords = keywordRes.choices[0]?.message?.content
          ?.split(',')
          .map((kw) => kw.trim().toLowerCase())
          .filter(Boolean);
        if (keywords && keywords.length) {
          const parts: string[] = [];
          for (const kw of keywords) {
            parts.push(`FIND('${kw}', LOWER({Category})) > 0`);
            parts.push(`FIND('${kw}', LOWER({Tag})) > 0`);
            parts.push(`FIND('${kw}', LOWER({Title})) > 0`);
            parts.push(`FIND('${kw}', LOWER({Description})) > 0`);
          }
          filterFormula = `OR(${parts.join(',')})`;
        }
      } catch (err) {
        console.error('Keyword extraction failed', err);
      }

      if (!filterFormula) {
        try {
          fallbackResults = await findRecipes(title, count);
          if (fallbackResults.length) {
            const idParts = fallbackResults.map((r) => `RECORD_ID()='${r.id}'`);
            filterFormula = `OR(${idParts.join(',')})`;
          } else {
            return NextResponse.json(
              { error: 'No relevant recipes found' },
              { status: 404 }
            );
          }
        } catch (err) {
          console.error('findRecipes fallback failed', err);
          return NextResponse.json(
            { error: 'Failed to find recipes' },
            { status: 500 }
          );
        }
      }

      const url = new URL(baseUrl);
      url.searchParams.append('filterByFormula', filterFormula);
      url.searchParams.append('maxRecords', String(count));
      for (const f of ['Title', 'URL', 'Image Link', 'Blog Source', 'Description', 'Category', 'Tag']) {
        url.searchParams.append('fields[]', f);
      }

      const res = await fetch(url.toString(), { headers });
      if (!res.ok) {
        const airtableError = await res.text();
        console.error('Airtable fetch failed', airtableError);
        return NextResponse.json(
          { error: 'Failed to fetch recipes', airtableError },
          { status: res.status }
        );
      }
      const data = await res.json();
      const records = (data.records || []) as any[];

      if (fallbackResults) {
        const order = new Map(fallbackResults.map((r, idx) => [r.id, idx]));
        records.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      }

      if (records.length === 0) {
        return NextResponse.json(
          { error: 'No recipe records found' },
          { status: 404 }
        );
      }

    let content = '';
    // Optionally generate an introduction using OpenAI, based on the given title
    if (title) {
      const introPrompt = `Write a short introductory paragraph for a blog post titled "${title}".`;
      const introResponse = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are an expert blog writer.' },
          { role: 'user', content: introPrompt }
        ]
      });
      const introText = introResponse.choices[0]?.message?.content?.trim() || '';
      if (introText) {
        content += `<!-- wp:paragraph -->\n<p>${introText}</p>\n<!-- /wp:paragraph -->\n\n`;
      }
    }

    // Generate a list section for each recipe record
    for (let i = 0; i < records.length; i++) {
      const fields = records[i].fields;
      const recipeName: string =
        fields.Name ||
        fields.Title ||
        fields.title ||
        fields.recipe ||
        `Recipe ${i + 1}`;

      const recipeUrl: string =
        fields.URL ||
        fields.Url ||
        fields.link ||
        fields.Link ||
        '';

      const imageUrl: string =
        fields['Image Link'] ||
        (Array.isArray(fields.Image) && fields.Image[0]?.url) ||
        fields.image ||
        '';

      const source: string = fields.Source || fields['Blog Source'] || '';

      let finalImageUrl = imageUrl;
      if (imageUrl) {
        try {
          const imgRes = await fetch(imageUrl);
          if (imgRes.ok) {
            const arrayBuffer = await imgRes.arrayBuffer();
            const imgBuffer = Buffer.from(arrayBuffer);
            const metadata = await sharp(imgBuffer).metadata();
            if (metadata.width && metadata.height) {
              const cropRegion = getCenterCropRegion(metadata.width, metadata.height);
              const croppedBuffer = await getCroppedImg(imgBuffer, cropRegion, 1280, 720);
              finalImageUrl = `data:image/jpeg;base64,${croppedBuffer.toString('base64')}`;
            }
          }
        } catch (e) {
          console.error('Image processing failed', e);
        }
      }

      // Always generate a 3-4 sentence description with OpenAI, using any
      // existing description as context when available
      const contextDesc =
        typeof fields.Description === 'string'
          ? fields.Description.slice(0, 200)
          : '';
      const nextFields = records[i + 1]?.fields;
      const nextName =
        nextFields &&
        (nextFields.Name ||
          nextFields.Title ||
          nextFields.title ||
          nextFields.recipe);
      let descPrompt = `Write a 3-4 sentence engaging description for the recipe "${recipeName}".`;
      if (contextDesc) {
        descPrompt += ` Use this context if helpful: ${contextDesc}`;
      }
      if (nextName) {
        descPrompt += ` Conclude with a short transitional sentence introducing the next recipe, "${nextName}".`;
      }
      const descResponse = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful culinary assistant.' },
          { role: 'user', content: descPrompt }
        ],
        max_tokens: Math.max(100, wordsPerItem)
      });
      const description = descResponse.choices[0]?.message?.content?.trim() || '';

      const prefix = formatNumberingPrefix(i + 1, numberingFormat);

      // Append the heading, image (if any), and paragraph blocks for this recipe item
      content += `<!-- wp:heading {"level":2} -->\n<h2>${prefix}${recipeName}</h2>\n<!-- /wp:heading -->\n`;
      if (finalImageUrl) {
        content +=
          `<!-- wp:image {"sizeSlug":"large","linkDestination":"custom"} -->\n` +
          `<figure class="wp-block-image size-large"><a href="${recipeUrl}" target="_blank" rel="noreferrer noopener"><img src="${finalImageUrl}" alt="${recipeName}"/></a>` +
          `${source ? `<figcaption class="wp-element-caption">Image by ${source}</figcaption>` : ''}</figure>\n` +
          `<!-- /wp:image -->\n`;
      }
      content +=
        `<!-- wp:paragraph -->\n<p>${description} ${recipeUrl ? `<a href="${recipeUrl}" target="_blank" rel="noreferrer noopener">${recipeName}</a>` : ''}</p>\n<!-- /wp:paragraph -->\n\n`;
    }

    return NextResponse.json({ content }, { status: 200 });
  } catch (err) {
    console.error('Error in generate-recipe route:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
