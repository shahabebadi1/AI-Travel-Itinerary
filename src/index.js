export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Parse JSON safely
    let destination, durationDays;
    try {
      const contentType = request.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        return new Response('Content-Type must be application/json', { status: 400 });
      }
      const data = await request.json();
      destination = data.destination;
      durationDays = data.durationDays;
    } catch (err) {
      return new Response('Invalid JSON', { status: 400 });
    }

    // Validate input
    if (!destination || !durationDays || typeof durationDays !== 'number' || durationDays <= 0) {
      return new Response('Invalid input: destination and positive durationDays required', { status: 400 });
    }

    const jobId = crypto.randomUUID();

    // Firestore settings
    const PROJECT_ID = 'travel-468612';
    const COLLECTION = 'itineraries';
    const DOC_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}/${jobId}`;

    // 🔐 GCP Service Account from environment variables
    const SERVICE_ACCOUNT = {
      client_email: env.GCP_CLIENT_EMAIL,
      private_key_id: env.GCP_PRIVATE_KEY_ID,
      private_key: env.GCP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    };

    if (!SERVICE_ACCOUNT.client_email || !SERVICE_ACCOUNT.private_key_id || !SERVICE_ACCOUNT.private_key) {
      console.error('[Auth] Missing GCP service account credentials');
      return new Response('Internal Server Error', { status: 500 });
    }

    // Helper: URL-safe base64 encoding
    function encodeBase64(data) {
      return btoa(data)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    }

    // Get OAuth2 access token using JWT
    async function getAccessToken() {
      const now = Math.floor(Date.now() / 1000);

      const header = encodeBase64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const payload = encodeBase64(JSON.stringify({
        iss: SERVICE_ACCOUNT.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
      }));

      const toSign = `${header}.${payload}`;

      // Clean private key
      const pkcs8Pem = SERVICE_ACCOUNT.private_key
        .replace(/-----[^-]+-----/g, '') // Remove BEGIN/END lines
        .replace(/\s/g, '');

      let keyBuffer;
      try {
        keyBuffer = Uint8Array.from(atob(pkcs8Pem), c => c.charCodeAt(0));
      } catch (err) {
        throw new Error('Failed to decode private key: ' + err.message);
      }

      const subtleKey = await crypto.subtle.importKey(
        'pkcs8',
        keyBuffer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
      );

      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        subtleKey,
        new TextEncoder().encode(toSign)
      );

      const sig = encodeBase64(String.fromCharCode(...new Uint8Array(signature)));
      const assertion = `${toSign}.${sig}`;

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion
        })
      });

      if (!tokenRes.ok) {
        const errData = await tokenRes.json().catch(() => ({}));
        throw new Error(`Failed to get access token: ${JSON.stringify(errData)}`);
      }

      const tokenData = await tokenRes.json();
      return tokenData.access_token;
    }

    // Convert JS object to Firestore format
    function toFirestoreFormat(obj) {
      const fields = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value === null) {
          fields[key] = { nullValue: null };
        } else if (typeof value === 'string') {
          fields[key] = { stringValue: value };
        } else if (typeof value === 'number') {
          if (Number.isInteger(value) && value >= -(2 ** 53) && value <= (2 ** 53)) {
            fields[key] = { integerValue: String(value) };
          } else {
            fields[key] = { doubleValue: value };
          }
        } else if (typeof value === 'boolean') {
          fields[key] = { booleanValue: value };
        } else if (value instanceof Date) {
          fields[key] = { timestampValue: value.toISOString() };
        } else if (Array.isArray(value)) {
          fields[key] = {
            arrayValue: {
              values: value.map(v => toFirestoreFormat({ v }).v)
            }
          };
        } else if (typeof value === 'object') {
          fields[key] = {
            mapValue: { fields: toFirestoreFormat(value) }
          };
        }
      }
      return fields;
    }

    // Save data to Firestore
    const saveToFirestore = async (data) => {
      try {
        const token = await getAccessToken();
        const response = await fetch(DOC_URL, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ fields: toFirestoreFormat(data) })
        });

        const jsonResponse = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(`Firestore error ${response.status}: ${JSON.stringify(jsonResponse)}`);
        }

        console.log(`[Firestore] Successfully saved job ${jobId}:`, data.status);
      } catch (err) {
        console.error(`[Firestore] Failed to save data for job ${jobId}:`, err);
        throw err;
      }
    };

    // Immediately save "processing" status
    try {
      await saveToFirestore({
        status: 'processing',
        destination,
        durationDays,
        createdAt: new Date(),
        completedAt: null,
        itinerary: [],
        error: null
      });
    } catch (err) {
      console.error('[Init] Failed to save processing status:', err);
      return new Response('Failed to initialize job', { status: 500 });
    }

    // Return 202 Accepted immediately
    const response = new Response(JSON.stringify({ jobId }), {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });

    // Offload background processing
    ctx.waitUntil(async () => {
      try {
        console.log(`[DEBUG] Background task started for jobId: ${jobId}`);
        console.log(`[DEBUG] OPENAI_API_KEY exists: ${!!env.OPENAI_API_KEY}`);
        console.log(`[DEBUG] GCP_CLIENT_EMAIL: ${SERVICE_ACCOUNT.client_email}`);
        console.log(`[DEBUG] GCP_PRIVATE_KEY_ID length: ${SERVICE_ACCOUNT.private_key_id.length}`);
        console.log(`[DEBUG] GCP_PRIVATE_KEY length: ${SERVICE_ACCOUNT.private_key.length}`);

        if (!env.OPENAI_API_KEY) {
          throw new Error('Missing OPENAI_API_KEY');
        }

        // Call OpenAI API
        const openAIResp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: `Generate a ${durationDays}-day travel itinerary for ${destination}. Return ONLY JSON: { "itinerary": [ { "day": 1, "theme": "string", "activities": [ { "time": "Morning|Afternoon|Evening", "description": "string", "location": "string" } ] } ] }. Rules: valid JSON only, no markdown, no extra text.`
              }
            ],
            max_tokens: 1500,
            temperature: 0.7,
            response_format: { type: "json_object" }
          })
        });

        const openAIResult = await openAIResp.json();
        console.log(`[OpenAI] Status: ${openAIResp.status}`);

        if (!openAIResp.ok) {
          throw new Error(openAIResult.error?.message || `OpenAI API error: ${openAIResult.error?.type}`);
        }

        const rawText = openAIResult.choices[0]?.message?.content?.trim();
        if (!rawText) {
          throw new Error('No response content from OpenAI');
        }

        console.log(`[LLM] Raw output:\n${rawText.substring(0, 600)}...`);

        let parsed;
        try {
          parsed = JSON.parse(rawText);
        } catch (parseErr) {
          throw new Error(`Failed to parse LLM output as JSON: ${parseErr.message}. Raw: ${rawText.substring(0, 500)}...`);
        }

        if (!Array.isArray(parsed.itinerary)) {
          throw new Error('Invalid itinerary format: expected array under "itinerary"');
        }

        // Update Firestore with completed result
        await saveToFirestore({
          status: 'completed',
          itinerary: parsed.itinerary,
          completedAt: new Date(),
          error: null
        });

        console.log(`[Success] Job ${jobId} completed and saved.`);
      } catch (err) {
        console.error(`[Error] Job ${jobId} failed:`, err);
        try {
          await saveToFirestore({
            status: 'failed',
            completedAt: new Date(),
            error: err.message?.substring(0, 255) || 'Unknown error'
          });
        } catch (saveErr) {
          console.error(`[Error] Failed to save failure status for job ${jobId}:`, saveErr);
        }
      }
    });

    return response;
  }
};